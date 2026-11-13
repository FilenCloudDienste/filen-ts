import type { EncodeCapabilities } from "@/lib/media/playback/capabilities.logic"
import { filterPreset } from "@/features/preview/imageEdit/lib/filters"
import { videoSaveTargets } from "@/features/preview/videoEdit/lib/targets"
import type {
	ExportDrop,
	ExportPlan,
	HdrHandling,
	OutputQuality,
	SnappedEdge,
	TimeRange,
	VideoCrop,
	VideoEditRecipe,
	VideoRotation,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"

// What an export of a recipe will do, decided up front from the recipe, what the editor read about the source and
// what this browser encodes. Pure: the Save popover shows it, and the export worker runs exactly this plan.
//
// Two modes. "copy" moves the source's coded video packets into the output untouched (I/O bound, works without any
// encoder): only cuts (each kept range starting at a key frame), rotation (as metadata) and speed (retimed packets,
// while the faster frame rate stays within the stream's codec level). Audio may still be re-encoded on that path (a
// gain, speed, or a codec players do not take in MP4). "transcode" decodes and encodes every kept frame: anything that
// changes pixels, or exact cuts.

// Why the copy path cannot be used. Stable ids: the UI words them.
export type TranscodeReason =
	"precise" | "crop" | "flip" | "resize" | "quality" | "adjust" | "text" | "speed" | "videoCodec" | "keyframes" | "gop"

// Editor options this browser can never do for this source, whatever the recipe (ExportPlan.unavailable): the editor
// disables them up front. Ids the editor knows.
export type UnavailableOption =
	"crop" | "rotate" | "flip" | "resize" | "quality" | "adjust" | "text" | "speed" | "gain" | "audioTracks" | "precise"

// What in a recipe this browser (or this source) cannot export; any of them refuses the export (exportBlockers).
export type ExportBlocker = TranscodeReason | "gain" | "audioCodec"

// Presentation-time slack: key frame times and range edges are compared within it.
const TIME_EPSILON = 0.001

// The most of one source GOP a fragmented copy holds in memory at once on iOS, whose tabs are killed far sooner
// than desktop ones (a fragment is at least one whole GOP).
export const IOS_GOP_BYTE_CAP = 48 * 1024 * 1024

// Audio codecs a copied track keeps in an MP4 or MOV output: what browsers play from one. Anything else (AC-3, DTS,
// TrueHD, ALAC, Vorbis, PCM) is re-encoded to AAC.
const COPYABLE_AUDIO: ReadonlySet<string> = new Set(["aac", "mp3", "opus", "flac"])

// Video codecs an MP4/MOV output carries as copied packets.
const COPYABLE_VIDEO: ReadonlySet<string> = new Set(["avc", "hevc", "vp9", "av1"])

// Frame rate a retimed copy may reach when the stream's level is not known.
const UNKNOWN_LEVEL_MAX_FPS = 60

// Transcode bits per pixel per frame for H.264 by quality; other codecs scale it (CODEC_EFFICIENCY).
const BITS_PER_PIXEL: Readonly<Record<OutputQuality, number>> = { high: 0.12, medium: 0.075, low: 0.045 }
const CODEC_EFFICIENCY: Readonly<Record<string, number>> = { avc: 1, hevc: 0.6, vp9: 0.7, av1: 0.55 }
const MIN_VIDEO_BITRATE = 300_000
const MAX_VIDEO_BITRATE = 60_000_000
// A re-encode never spends much more per pixel than the source did.
const SOURCE_BITRATE_HEADROOM = 1.2
export const AAC_BITRATE_PER_CHANNEL = 80_000
// When nothing better is known: an audio track's share of a source.
const ASSUMED_AUDIO_BITRATE = 160_000
// fMP4 boxes (moof per fragment, mfra) over the media bytes.
const CONTAINER_OVERHEAD = 1.01
// Rough throughputs for the time estimate: the read and the upload overlap; decode + encode in pixels per second.
const NET_BYTES_PER_SECOND = 8_000_000
const CODEC_PIXELS_PER_SECOND = 120_000_000

// The output's frame rate cap on the transcode path: frames beyond it are dropped (a 4× speed-up of 30 fps plays at
// 30 fps, not 120).
export function transcodeFrameRate(source: VideoSourceInfo, speed: number): number {
	const base = source.frameRate > 0 ? source.frameRate : 30

	return Math.min(base * speed, Math.max(base, 30))
}

export interface OutputGeometry {
	// The output's display size (after crop, rotation and scale), even, square pixels.
	width: number
	height: number
	// The source frame is resized (only the GPU pass does that).
	scaled: boolean
	// The source's coded frame size (before its pixel aspect ratio and rotation).
	codedWidth: number
	codedHeight: number
	// The crop in CODED pixels (before the pixel aspect ratio and rotation), even: a VideoFrame visibleRect. Null for
	// the whole frame.
	codedCrop: VideoCrop | null
	// The same rectangle in the unrotated frame's square pixels (what a decoded VideoFrame's display size measures):
	// the GPU pass's crop. Null exactly when codedCrop is.
	squareCrop: VideoCrop | null
	// The unrotated source picture in square pixels (what codedWidth × codedHeight shows as).
	squareWidth: number
	squareHeight: number
	// Source rotation plus the recipe's, clockwise: what a path that leaves pixels unrotated writes as metadata.
	rotation: VideoRotation
}

function even(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2)
}

function quarterTurns(rotation: VideoRotation): boolean {
	return rotation === 90 || rotation === 270
}

// A display-space rectangle in the unrotated frame, for a source shown rotated clockwise by `rotation`.
export function displayToCoded(crop: VideoCrop, rotation: VideoRotation, codedWidth: number, codedHeight: number): VideoCrop {
	switch (rotation) {
		case 90: {
			return { x: crop.y, y: codedHeight - crop.x - crop.width, width: crop.height, height: crop.width }
		}

		case 180: {
			return { x: codedWidth - crop.x - crop.width, y: codedHeight - crop.y - crop.height, width: crop.width, height: crop.height }
		}

		case 270: {
			return { x: codedWidth - crop.y - crop.height, y: crop.x, width: crop.height, height: crop.width }
		}

		default: {
			return crop
		}
	}
}

function evenCrop(crop: VideoCrop, width: number, height: number): VideoCrop {
	const x = Math.min(Math.max(0, Math.floor(crop.x / 2) * 2), Math.max(0, width - 2))
	const y = Math.min(Math.max(0, Math.floor(crop.y / 2) * 2), Math.max(0, height - 2))

	return {
		x,
		y,
		width: Math.min(even(crop.width), Math.floor((width - x) / 2) * 2),
		height: Math.min(even(crop.height), Math.floor((height - y) / 2) * 2)
	}
}

// The unrotated source frame: its coded size and that size in square pixels (they differ for an anamorphic source).
export interface SourceFrame {
	codedWidth: number
	codedHeight: number
	squareWidth: number
	squareHeight: number
}

export function sourceFrame(source: VideoSourceInfo): SourceFrame {
	const sideways = quarterTurns(source.rotation)
	const squareWidth = sideways ? source.height : source.width
	const squareHeight = sideways ? source.width : source.height

	return {
		codedWidth: source.codedWidth > 0 ? source.codedWidth : squareWidth,
		codedHeight: source.codedHeight > 0 ? source.codedHeight : squareHeight,
		squareWidth,
		squareHeight
	}
}

// The one conversion between the two units of the unrotated frame: a square-pixel rectangle as coded pixels, even
// (4:2:0 chroma), and that coded rectangle back in square pixels. The crop-only path (visibleRect, coded) and the GPU
// pass (square) both take their crop from here, so they cut the same pixels.
export function squareToCodedCrop(crop: VideoCrop, frame: SourceFrame): VideoCrop {
	const sx = frame.squareWidth > 0 ? frame.codedWidth / frame.squareWidth : 1
	const sy = frame.squareHeight > 0 ? frame.codedHeight / frame.squareHeight : 1

	return evenCrop(
		{
			x: Math.round(crop.x * sx),
			y: Math.round(crop.y * sy),
			width: Math.round(crop.width * sx),
			height: Math.round(crop.height * sy)
		},
		frame.codedWidth,
		frame.codedHeight
	)
}

export function codedToSquareCrop(crop: VideoCrop, frame: SourceFrame): VideoCrop {
	const sx = frame.codedWidth > 0 ? frame.squareWidth / frame.codedWidth : 1
	const sy = frame.codedHeight > 0 ? frame.squareHeight / frame.codedHeight : 1

	return { x: crop.x * sx, y: crop.y * sy, width: crop.width * sx, height: crop.height * sy }
}

export function outputGeometry(recipe: VideoEditRecipe, source: VideoSourceInfo): OutputGeometry {
	const frame = sourceFrame(source)
	const displayCrop = recipe.crop === null ? null : evenCrop(recipe.crop, source.width, source.height)
	const whole = displayCrop === null || (displayCrop.width >= source.width - 1 && displayCrop.height >= source.height - 1)
	// A source with an odd coded side is trimmed by a pixel (encoders take even sizes only), which is no crop to speak of.
	const codedCrop =
		whole && frame.codedWidth % 2 === 0 && frame.codedHeight % 2 === 0
			? null
			: squareToCodedCrop(
					displayToCoded(
						whole ? { x: 0, y: 0, width: source.width, height: source.height } : displayCrop,
						source.rotation,
						frame.squareWidth,
						frame.squareHeight
					),
					frame
				)
	const squareCrop = codedCrop === null ? null : codedToSquareCrop(codedCrop, frame)
	// The kept picture in display space (square pixels, the source's rotation applied).
	const kept = squareCrop ?? { width: frame.squareWidth, height: frame.squareHeight }
	const sourceSideways = quarterTurns(source.rotation)
	const displayWidth = sourceSideways ? kept.height : kept.width
	const displayHeight = sourceSideways ? kept.width : kept.height
	const turned = quarterTurns(recipe.rotate)
	const width = turned ? displayHeight : displayWidth
	const height = turned ? displayWidth : displayHeight
	const short = Math.min(width, height)
	const target = recipe.output.resolution === "original" ? short : recipe.output.resolution
	const scale = target < short ? target / short : 1

	return {
		width: even(Math.round(width * scale)),
		height: even(Math.round(height * scale)),
		scaled: scale < 1,
		codedWidth: frame.codedWidth,
		codedHeight: frame.codedHeight,
		codedCrop,
		squareCrop,
		squareWidth: frame.squareWidth,
		squareHeight: frame.squareHeight,
		rotation: ((source.rotation + recipe.rotate) % 360) as VideoRotation
	}
}

export function hasColourWork(recipe: VideoEditRecipe): boolean {
	const adjust = recipe.adjust

	return (
		filterPreset(recipe.filter) !== null ||
		adjust.exposure !== 0 ||
		adjust.brightness !== 0 ||
		adjust.contrast !== 0 ||
		adjust.highlights !== 0 ||
		adjust.shadows !== 0 ||
		adjust.warmth !== 0 ||
		adjust.tint !== 0 ||
		adjust.saturation !== 0 ||
		adjust.vibrance !== 0
	)
}

// Whether frames go through the GPU pass for the recipe's own sake (colour, text, a flip, a resize); a crop alone is a
// view onto the decoded frame and a rotation is metadata.
export function needsPixelPass(recipe: VideoEditRecipe, geometry: Pick<OutputGeometry, "scaled">): boolean {
	return hasColourWork(recipe) || recipe.text.length > 0 || recipe.flipH || recipe.flipV || geometry.scaled
}

export function isHdrSource(source: VideoSourceInfo): boolean {
	return source.transfer !== "sdr"
}

// mediabunny's codec id for a codec string or id ("avc1.640028" or "avc").
export function videoCodecId(codec: string | null): string | null {
	if (codec === null) {
		return null
	}

	const lower = codec.toLowerCase()

	if (lower.startsWith("avc")) return "avc"
	if (lower.startsWith("hvc") || lower.startsWith("hev") || lower === "hevc") return "hevc"
	if (lower.startsWith("vp09") || lower === "vp9") return "vp9"
	if (lower.startsWith("vp08") || lower === "vp8") return "vp8"
	if (lower.startsWith("av01") || lower === "av1") return "av1"

	return lower
}

export function audioCodecId(codec: string | null): string | null {
	if (codec === null) {
		return null
	}

	const lower = codec.toLowerCase()

	if (lower.startsWith("mp4a.40") || lower === "aac") return "aac"
	if (lower === "mp4a.6b" || lower === "mp4a.69" || lower === "mp3") return "mp3"
	if (lower === "opus") return "opus"
	if (lower === "flac") return "flac"

	return lower
}

// H.264 MaxMBPS by level_idc (Table A-1); 9 is level 1b as Annex A writes it in some streams.
const AVC_MAX_MBPS: ReadonlyMap<number, number> = new Map([
	[9, 1485],
	[10, 1485],
	[11, 3000],
	[12, 6000],
	[13, 11_880],
	[20, 11_880],
	[21, 19_800],
	[22, 20_250],
	[30, 40_500],
	[31, 108_000],
	[32, 216_000],
	[40, 245_760],
	[41, 245_760],
	[42, 522_240],
	[50, 589_824],
	[51, 983_040],
	[52, 2_073_600],
	[60, 4_177_920],
	[61, 8_355_840],
	[62, 16_711_680]
])

// HEVC MaxLumaSr by general_level_idc (30 × level; Table A.8).
const HEVC_MAX_LUMA_SR: ReadonlyMap<number, number> = new Map([
	[30, 552_960],
	[60, 3_686_400],
	[63, 7_372_800],
	[90, 16_588_800],
	[93, 33_177_600],
	[120, 66_846_720],
	[123, 133_693_440],
	[150, 267_386_880],
	[153, 534_773_760],
	[156, 1_069_547_520],
	[180, 1_069_547_520],
	[183, 2_139_095_040],
	[186, 4_278_190_080]
])

// The highest frame rate the stream's codec level allows at its size, from its full codec string; null when the
// string names no level this knows.
export function levelMaxFrameRate(codecString: string | null, codedWidth: number, codedHeight: number): number | null {
	if (codecString === null) {
		return null
	}

	const avc = /^avc[13]\.[0-9a-f]{4}([0-9a-f]{2})$/i.exec(codecString)

	if (avc?.[1] !== undefined) {
		const maxMbps = AVC_MAX_MBPS.get(Number.parseInt(avc[1], 16))
		const macroblocks = Math.ceil(codedWidth / 16) * Math.ceil(codedHeight / 16)

		return maxMbps === undefined || macroblocks === 0 ? null : maxMbps / macroblocks
	}

	const hevc = /^(?:hvc1|hev1)\.[^.]+\.[^.]+\.[LH](\d+)/i.exec(codecString)

	if (hevc?.[1] !== undefined) {
		const maxLumaSr = HEVC_MAX_LUMA_SR.get(Number.parseInt(hevc[1], 10))
		const pixels = codedWidth * codedHeight

		return maxLumaSr === undefined || pixels === 0 ? null : maxLumaSr / pixels
	}

	return null
}

// Whether the copy path can retime the stream to `speed` by its timestamps alone.
export function copySpeedFits(source: VideoSourceInfo, speed: number): boolean {
	if (speed <= 1) {
		return true
	}

	const frame = sourceFrame(source)
	const limit = levelMaxFrameRate(source.videoCodec, frame.codedWidth, frame.codedHeight) ?? UNKNOWN_LEVEL_MAX_FPS

	return source.frameRate * speed <= limit + TIME_EPSILON
}

// The kept ranges as the copy path cuts them: each start moved to the first key frame at or after it (a range only
// ever shrinks, so nothing the user removed comes back), the end left where it is. A range with no key frame before
// its end is gone. `snapped` lists the starts that moved by more than half a frame.
export function copyRanges(
	keep: readonly TimeRange[],
	keyframes: Float64Array,
	frameRate: number
): { ranges: TimeRange[]; snapped: SnappedEdge[] } {
	const ranges: TimeRange[] = []
	const snapped: SnappedEdge[] = []
	const visible = frameRate > 0 ? 0.5 / frameRate : TIME_EPSILON
	let at = 0

	for (const range of keep) {
		// Key frames are ascending and so are the ranges: the search resumes where the last one ended.
		while (at < keyframes.length && (keyframes[at] ?? Number.POSITIVE_INFINITY) < range.start - TIME_EPSILON) {
			at++
		}

		const key = keyframes[at]

		if (key === undefined || key >= range.end - TIME_EPSILON) {
			snapped.push({ requested: range.start, actual: range.end })

			continue
		}

		const start = Math.max(key, range.start)

		if (start - range.start > visible) {
			snapped.push({ requested: range.start, actual: start })
		}

		ranges.push({ start, end: range.end })
	}

	return { ranges, snapped }
}

// Exact cuts: the ranges as the recipe has them, clamped to the source.
export function exactRanges(keep: readonly TimeRange[], duration: number): TimeRange[] {
	return keep
		.map(range => ({ start: Math.max(0, range.start), end: Math.min(duration, range.end) }))
		.filter(range => range.end - range.start > TIME_EPSILON)
}

export function rangesDuration(ranges: readonly TimeRange[]): number {
	let total = 0

	for (const range of ranges) {
		total += range.end - range.start
	}

	return total
}

// Where a source time lands on the output timeline; null for a time that was cut.
export function sourceToOutputTime(ranges: readonly TimeRange[], speed: number, time: number): number | null {
	let before = 0

	for (const range of ranges) {
		if (time < range.start - TIME_EPSILON) {
			return null
		}

		if (time <= range.end + TIME_EPSILON) {
			return (before + Math.min(Math.max(time - range.start, 0), range.end - range.start)) / speed
		}

		before += range.end - range.start
	}

	return null
}

// The audio tracks (their numbers) the output carries.
export function keptAudioTracks(recipe: VideoEditRecipe, source: VideoSourceInfo): number[] {
	if (recipe.audio.mute || source.audio.length === 0) {
		return []
	}

	const keep = recipe.audio.keepTracks

	if (keep === "first") {
		return [source.audio[0]?.number ?? 1]
	}

	return source.audio.filter(track => keep.includes(track.number)).map(track => track.number)
}

// Whether an audio track must be decoded and encoded again (AAC) rather than copied.
export function audioNeedsTranscode(recipe: VideoEditRecipe, codec: string | null): boolean {
	return recipe.audio.gainDb !== 0 || recipe.speed !== 1 || !COPYABLE_AUDIO.has(audioCodecId(codec) ?? "")
}

// The video codec a transcode encodes with: HEVC Main 10 to keep HDR, else the browser's first export codec.
export function transcodeVideoCodec(caps: EncodeCapabilities, hdr: HdrHandling | null): "avc" | "hevc" | "vp9" | "av1" | null {
	if (hdr === "hevc10") {
		return "hevc"
	}

	return caps.firstVideoCodec
}

// The video bitrate a transcode targets: the bits-per-pixel model for the size, rate and quality, never much more per
// pixel than the source spent.
export function transcodeBitrate(params: {
	width: number
	height: number
	frameRate: number
	quality: OutputQuality
	codec: string
	sourceVideoBitrate: number | null
	sourcePixels: number
}): number {
	const { width, height, frameRate, quality, codec, sourceVideoBitrate, sourcePixels } = params
	const modelled = width * height * frameRate * BITS_PER_PIXEL[quality] * (CODEC_EFFICIENCY[codec] ?? 1)
	const ceiling =
		sourceVideoBitrate === null || sourcePixels <= 0
			? MAX_VIDEO_BITRATE
			: sourceVideoBitrate * Math.min(1, (width * height) / sourcePixels) * SOURCE_BITRATE_HEADROOM

	return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, Math.min(modelled, ceiling))))
}

export function aacBitrate(channels: number): number {
	return AAC_BITRATE_PER_CHANNEL * Math.min(Math.max(channels, 1), 2)
}

// The source's video bitrate: the whole file's, less what its audio tracks are assumed to take.
function sourceVideoBitrate(source: VideoSourceInfo): number | null {
	if (source.duration <= 0 || source.bytes <= 0) {
		return null
	}

	return Math.max(MIN_VIDEO_BITRATE, (source.bytes * 8) / source.duration - source.audio.length * ASSUMED_AUDIO_BITRATE)
}

// The largest source GOP in bytes, by the average bitrate over the longest key frame interval.
export function largestGopBytes(source: VideoSourceInfo): number {
	const keyframes = source.keyframes

	if (keyframes.length === 0 || source.duration <= 0) {
		return source.bytes
	}

	let longest = 0
	let previous = keyframes[0] ?? 0

	for (let index = 1; index < keyframes.length; index++) {
		const key = keyframes[index] ?? previous

		longest = Math.max(longest, key - previous)
		previous = key
	}

	longest = Math.max(longest, source.duration - previous)

	return (source.bytes / source.duration) * longest
}

export interface PlanContext {
	// The file's name: an in-place save keeps its container.
	name?: string
	// The account keeps file versions; undefined when not known (treated as on).
	versioning?: boolean | undefined
	// iOS or iPadOS: a WebKit tab with a low memory ceiling.
	ios?: boolean
}

// What the browser can do for edits at all, for the editor to disable options with a reason before anything is
// asked of it.
export interface EditAbilities {
	// Pixels can change (WebCodecs video decode + encode for some export codec).
	transcode: boolean
	// Audio can be decoded and encoded again (gain, speed, codecs MP4 players do not take).
	audioTranscode: boolean
}

export function editAbilities(source: VideoSourceInfo, caps: EncodeCapabilities): EditAbilities {
	return {
		transcode: source.previewable && caps.videoEncoder && caps.firstVideoCodec !== null,
		audioTranscode: caps.audioEncoder
	}
}

function uniquePush<T>(list: T[], value: T): void {
	if (!list.includes(value)) {
		list.push(value)
	}
}

// The options to disable for this source in this browser.
export function unavailableOptions(source: VideoSourceInfo, caps: EncodeCapabilities): UnavailableOption[] {
	const abilities = editAbilities(source, caps)
	const unavailable: UnavailableOption[] = []

	if (!abilities.transcode) {
		unavailable.push("crop", "flip", "resize", "quality", "adjust", "text", "precise")
	}

	if (!abilities.audioTranscode) unavailable.push("gain")

	return unavailable
}

// What in `recipe` cannot be exported here: the export refuses when this is not empty.
export function exportBlockers(
	recipe: VideoEditRecipe,
	source: VideoSourceInfo,
	caps: EncodeCapabilities,
	context: PlanContext = {}
): ExportBlocker[] {
	return analyse(recipe, source, caps, context).blockers
}

function muted(recipe: VideoEditRecipe): VideoEditRecipe {
	return { ...recipe, audio: { ...recipe.audio, mute: true } }
}

export function planExport(
	recipe: VideoEditRecipe,
	source: VideoSourceInfo,
	caps: EncodeCapabilities,
	context: PlanContext = {}
): ExportPlan {
	const { plan, blockers } = analyse(recipe, source, caps, context)

	return {
		...plan,
		blockers,
		mutingUnblocks: blockers.length > 0 && !recipe.audio.mute && analyse(muted(recipe), source, caps, context).blockers.length === 0
	}
}

function analyse(
	recipe: VideoEditRecipe,
	source: VideoSourceInfo,
	caps: EncodeCapabilities,
	context: PlanContext
): { plan: Omit<ExportPlan, "blockers" | "mutingUnblocks">; blockers: ExportBlocker[] } {
	const abilities = editAbilities(source, caps)
	const geometry = outputGeometry(recipe, source)
	const hdrSource = isHdrSource(source)
	const colour = hasColourWork(recipe)
	const reasons: TranscodeReason[] = []
	const blockers: ExportBlocker[] = []

	// What forces every frame through decode and encode.
	if (geometry.codedCrop !== null) reasons.push("crop")
	if (recipe.flipH || recipe.flipV) reasons.push("flip")
	if (geometry.scaled) reasons.push("resize")
	if (recipe.output.quality !== "high") reasons.push("quality")
	if (colour) reasons.push("adjust")
	if (recipe.text.length > 0) reasons.push("text")
	if (recipe.speed !== 1 && !copySpeedFits(source, recipe.speed)) reasons.push("speed")
	if (!COPYABLE_VIDEO.has(videoCodecId(source.videoCodec) ?? "")) reasons.push("videoCodec")

	const snappedCopy = copyRanges(recipe.keep, source.keyframes, source.frameRate)

	if (source.keyframes.length === 0 || snappedCopy.ranges.length === 0) {
		reasons.push("keyframes")
	} else if (recipe.precise && snappedCopy.snapped.length > 0) {
		reasons.push("precise")
	}

	if (context.ios === true && largestGopBytes(source) > IOS_GOP_BYTE_CAP) {
		reasons.push("gop")
	}

	const mode = reasons.length === 0 ? "copy" : "transcode"

	if (mode === "transcode" && !abilities.transcode) {
		for (const reason of reasons) {
			uniquePush(blockers, reason)
		}
	}

	// HDR stays HDR where no pixel is changed: copied, or re-encoded as HEVC Main 10 when only cut, cropped (a view onto
	// the decoded frame), turned (metadata), retimed or re-compressed. The GPU pass is 8-bit SDR, so colour, text, a flip
	// or a resize tone-maps to SDR, which the Save popover says.
	const hdr: HdrHandling | null = !hdrSource
		? null
		: mode === "copy"
			? "keep"
			: caps.video.hevcMain10 && !needsPixelPass(recipe, geometry)
				? "hevc10"
				: "toSdr"

	const audioTracks = keptAudioTracks(recipe, source)
	const audioInfo = source.audio.filter(track => audioTracks.includes(track.number))
	// Audio packets are all key packets: a track the recipe leaves as it is is copied on either path.
	const audioReencoded = audioInfo.filter(track => audioNeedsTranscode(recipe, track.codec))

	if (audioReencoded.length > 0 && !abilities.audioTranscode) {
		if (recipe.audio.gainDb !== 0) uniquePush(blockers, "gain")
		if (recipe.speed !== 1) uniquePush(blockers, "speed")
		if (audioInfo.some(track => !COPYABLE_AUDIO.has(audioCodecId(track.codec) ?? ""))) uniquePush(blockers, "audioCodec")
	}

	const dropped: ExportDrop[] = []

	if (source.hasSubtitles) dropped.push("subtitles")
	if (source.hasChapters) dropped.push("chapters")
	if (!recipe.audio.mute && audioTracks.length < source.audio.length) dropped.push("extraAudio")
	if (recipe.removeLocation && source.hasLocation) dropped.push("location")

	const ranges = mode === "copy" ? snappedCopy.ranges : exactRanges(recipe.keep, source.duration)
	const kept = rangesDuration(ranges)
	const outputDuration = kept / recipe.speed
	const { container, targets } = videoSaveTargets({
		name: context.name ?? "",
		container: source.container,
		versioning: context.versioning
	})
	const keptFraction = source.duration > 0 ? Math.min(1, kept / source.duration) : 1
	const keptSourceBytes = source.bytes * keptFraction
	const audioBytes = (bitrate: number): number => (bitrate * outputDuration) / 8
	let estimateBytes: number
	let estimateSeconds: number

	if (mode === "copy") {
		const droppedAudio = source.audio.length - audioTracks.length
		const reencodedAudio = audioReencoded.reduce(
			(total, track) => total + audioBytes(aacBitrate(track.channels)) - (ASSUMED_AUDIO_BITRATE * kept) / 8,
			0
		)

		estimateBytes =
			Math.max(0, keptSourceBytes - (droppedAudio * ASSUMED_AUDIO_BITRATE * kept) / 8 + reencodedAudio) * CONTAINER_OVERHEAD
		estimateSeconds = Math.max(keptSourceBytes, estimateBytes) / NET_BYTES_PER_SECOND
	} else {
		const codec = transcodeVideoCodec(caps, hdr) ?? "avc"
		const frameRate = transcodeFrameRate(source, recipe.speed)
		const videoBitrate = transcodeBitrate({
			width: geometry.width,
			height: geometry.height,
			frameRate,
			quality: recipe.output.quality,
			codec,
			sourceVideoBitrate: sourceVideoBitrate(source),
			sourcePixels: source.width * source.height
		})
		const audio = audioInfo.reduce(
			(total, track) =>
				total + (audioReencoded.includes(track) ? audioBytes(aacBitrate(track.channels)) : (ASSUMED_AUDIO_BITRATE * kept) / 8),
			0
		)

		estimateBytes = (audioBytes(videoBitrate) + audio) * CONTAINER_OVERHEAD

		const decodedPixels = source.width * source.height * source.frameRate * kept
		const encodedPixels = geometry.width * geometry.height * frameRate * outputDuration

		estimateSeconds = Math.max(
			Math.max(keptSourceBytes, estimateBytes) / NET_BYTES_PER_SECOND,
			(decodedPixels + encodedPixels) / CODEC_PIXELS_PER_SECOND
		)
	}

	const plan: Omit<ExportPlan, "blockers" | "mutingUnblocks"> = {
		mode,
		transcodeReasons: mode === "copy" ? [] : reasons,
		unavailable: unavailableOptions(source, caps),
		dropped,
		hdr,
		container,
		targets,
		estimateBytes: Math.round(estimateBytes),
		estimateSeconds: Math.ceil(estimateSeconds),
		snapped: mode === "copy" ? snappedCopy.snapped : [],
		outputDuration
	}

	return { plan, blockers }
}

// The ranges an export cuts for a plan (copy: snapped to key frames; transcode: exact).
export function plannedRanges(recipe: VideoEditRecipe, source: VideoSourceInfo, mode: ExportPlan["mode"]): TimeRange[] {
	return mode === "copy" ? copyRanges(recipe.keep, source.keyframes, source.frameRate).ranges : exactRanges(recipe.keep, source.duration)
}
