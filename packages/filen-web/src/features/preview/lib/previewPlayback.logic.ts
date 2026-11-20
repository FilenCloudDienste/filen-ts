import {
	parseSubtitleTokens,
	subtitleFormatFromExtension,
	type LadderDecision,
	type MediaCodec,
	type ProbeContainer,
	type SubtitleFormat,
	type VideoProbe
} from "@filen/shared/videos"
import { extensionStart } from "@filen/shared"
import type { ContainerTrack, TrackKind } from "@/features/preview/lib/containerTracks"
import type { MseFailure } from "@/lib/media/mseController"

// Pure decisions behind the preview's media playback: which route a file starts on, what the ladder's
// verdict names when nothing plays, and which files beside a video are its subtitles.

// Containers a browser plays from a plain src. Everything else (Matroska, transport streams) goes through
// the playback ladder from the start: MKV is never played direct.
const DIRECT_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "mov", "webm"])

// "direct": the service worker's range route on a plain <video src>, exactly as before the ladder existed,
// so a file the browser plays costs no probe. "ladder": probe, then direct/remux/transcode sessions.
export type PreviewVideoRoute = "direct" | "ladder"

// A `.ts`/`.mts` name, which a probe settles TypeScript against a transport stream for.
export function isTransportStreamName(name: string): boolean {
	const dot = extensionStart(name)
	const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()

	return extension === "ts" || extension === "mts"
}

// Whether a browser plays the container from a plain <video src> at all (Matroska and transport streams never).
export function playsFromPlainSrc(extension: string): boolean {
	return DIRECT_EXTENSIONS.has(extension)
}

export function initialVideoRoute(params: { extension: string; contentType: string | null; streamAvailable: boolean }): PreviewVideoRoute {
	const { extension, contentType, streamAvailable } = params

	return streamAvailable && contentType !== null && playsFromPlainSrc(extension) ? "direct" : "ladder"
}

// The tracks a probe declares, in the shape the browser-support check reads.
export function probeTracks(probe: VideoProbe): ContainerTrack[] {
	const tracks: ContainerTrack[] = []

	if (probe.video !== null) {
		tracks.push({ kind: "video", codec: probe.video.codec })
	}

	for (const audio of probe.audio) {
		tracks.push({ kind: "audio", codec: audio.codec })
	}

	return tracks
}

const NO_PICTURE_REASONS: ReadonlySet<string> = new Set([
	"no-video",
	"video-codec-unknown",
	"remux-video-unsupported",
	"remux-decode-unsupported",
	"dolby-vision-profile-5"
])

// No rung only because this browser has no way to stream a file it cannot play from a plain src (no
// MediaSource): nothing about the file's codecs, so nothing names them.
export function cannotStream(decision: LadderDecision | null): boolean {
	return decision?.reasons.includes("no-media-source") === true
}

// The container to name when no rung exists for it in this browser, whatever its tracks hold (Ogg where neither the
// element nor a remux reads it): naming its codecs would suggest they are the problem. Null otherwise.
export function unplayableContainer(probe: VideoProbe | null, decision: LadderDecision | null): ProbeContainer | null {
	return probe !== null && decision?.reasons.includes("container-unsupported") === true ? probe.container : null
}

// The codecs to name when the ladder found no rung: the picture's when that is what failed, else every
// track's codec the file declares. Empty when the file names none this app recognises.
export function unplayableCodecs(probe: VideoProbe | null, decision: LadderDecision | null): MediaCodec[] {
	if (probe === null) {
		return []
	}

	const codecs: MediaCodec[] = []
	const add = (codec: MediaCodec | null): void => {
		if (codec !== null && !codecs.includes(codec)) {
			codecs.push(codec)
		}
	}

	if (decision?.reasons.some(reason => NO_PICTURE_REASONS.has(reason)) === true) {
		add(probe.video?.codec ?? null)

		if (codecs.length > 0) {
			return codecs
		}
	}

	add(probe.video?.codec ?? null)

	for (const audio of probe.audio) {
		add(audio.codec)
	}

	return codecs
}

// The audio codec a "video-only" rung plays without: the chosen track's, else the first.
export function silentAudioCodec(probe: VideoProbe, audioIndex: number): MediaCodec | null {
	return (probe.audio[audioIndex] ?? probe.audio[0])?.codec ?? null
}

// A track kind the element decoded nothing of is only a suspicion (a file may have no audio at all): the
// probe settles it, naming the first track of such a kind the browser says it cannot decode.
export function confirmedGap(probe: VideoProbe, kinds: readonly TrackKind[], canPlay: (codec: MediaCodec) => boolean): MediaCodec | null {
	for (const track of probeTracks(probe)) {
		if (track.codec !== null && kinds.includes(track.kind) && !canPlay(track.codec)) {
			return track.codec
		}
	}

	return null
}

export interface SidecarCandidate {
	uuid: string
	name: string
	size: number
}

export interface PreviewSidecarSubtitle {
	uuid: string
	name: string
	format: SubtitleFormat
	lang: string | null
	forced: boolean
	sdh: boolean
	title: string
}

function extensionOfName(name: string): string {
	const dot = extensionStart(name)

	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

// Subtitle files beside a video whose name is the video's stem plus optional tokens ("Movie.en.forced.srt"),
// in listing order. A `.sub` with an `.idx` of the same stem is VobSub (images), so it is left out; one
// without is presumed MicroDVD. Files over `maxBytes` are left out: nothing would load them.
export function sidecarSubtitles(videoName: string, siblings: readonly SidecarCandidate[], maxBytes: number): PreviewSidecarSubtitle[] {
	const videoDot = extensionStart(videoName)
	const stem = (videoDot === -1 ? videoName : videoName.slice(0, videoDot)).toLowerCase()
	const idxStems = new Set<string>()

	for (const sibling of siblings) {
		const lower = sibling.name.toLowerCase()

		if (lower.endsWith(".idx")) {
			idxStems.add(lower.slice(0, -4))
		}
	}

	const found: PreviewSidecarSubtitle[] = []

	for (const sibling of siblings) {
		const dot = extensionStart(sibling.name)
		const extension = extensionOfName(sibling.name)
		// Text subtitles the browser can show; an image format (PGS, VobSub) has no parser.
		const format = dot === -1 ? null : subtitleFormatFromExtension(extension)

		if (format === null || sibling.size > maxBytes || sibling.size === 0) {
			continue
		}

		const name = sibling.name.slice(0, dot)
		const base = name.toLowerCase()

		if (base !== stem && !base.startsWith(`${stem}.`)) {
			continue
		}

		if (extension === "sub" && idxStems.has(base)) {
			continue
		}

		const end = stemEnd(name, stem)
		const tokens = end === name.length ? [] : name.slice(end + 1).split(".")
		const info = parseSubtitleTokens(tokens)

		found.push({
			uuid: sibling.uuid,
			name: sibling.name,
			format,
			lang: info.language,
			forced: info.forced,
			sdh: info.sdh,
			title: info.title
		})
	}

	return found
}

// Where the lowercased `stem` ends in `name`, measured on `name` itself: lowercasing can change a name's length
// ("İ" becomes two code units), so the lowercased stem's length can misplace where the tokens start. `name`
// is known to lowercase to the stem, alone or followed by a dot.
function stemEnd(name: string, stem: string): number {
	for (let end = name.indexOf("."); end !== -1; end = name.indexOf(".", end + 1)) {
		if (name.slice(0, end).toLowerCase() === stem) {
			return end
		}
	}

	return name.length
}

// What an audio stream's MediaSource failure says: "format" when the browser cannot decode what the file
// holds (no Retry plays it), "other" when the bytes or a worker went away (Retry may).
export function mseFailureKind(reason: MseFailure): "format" | "other" {
	return reason === "media" || reason === "keyframeIntervalTooLarge" ? "format" : "other"
}

// The same for a failure to open the stream: only MediaSource refusing every track it was offered is the format.
export function mseOpenFailureKind(error: unknown): "format" | "other" {
	return error instanceof DOMException && error.name === "NotSupportedError" ? "format" : "other"
}
