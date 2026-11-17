import { codecStringAlternatives } from "./codecString"

export type LadderPath = "direct" | "remux" | "remux+transcode" | "video-only" | "unsupported"

export type LadderBrowser = "chrome" | "edge" | "firefox" | "safari" | "other"

export type AudioTarget = "aac" | "opus" | "aac-wasm"

export interface DecodingVerdict {
	supported: boolean
	smooth?: boolean
}

// Everything the ladder needs from the browser, gathered up front (see `ladderQueries`); a missing key counts as "no".
export interface PlaybackCapabilities {
	browser: LadderBrowser
	// `MediaSource` or `ManagedMediaSource` exists.
	mediaSource: boolean
	// `HTMLMediaElement.audioTracks` exists (Safari).
	audioTracks: boolean
	// MIME with codecs -> `canPlayType` result ("", "maybe", "probably").
	canPlayType: Readonly<Record<string, string>>
	// MIME with codecs -> `MediaSource.isTypeSupported`.
	isTypeSupported: Readonly<Record<string, boolean>>
	// MIME with codecs -> `decodingInfo({type: "file"})` / `({type: "media-source"})`.
	decodingInfoFile: Readonly<Record<string, DecodingVerdict>>
	decodingInfoMediaSource: Readonly<Record<string, DecodingVerdict>>
	// Targets whose `AudioEncoder.isConfigSupported` passed (wasm AAC only after native failed).
	audioEncoders: readonly AudioTarget[]
	// Codec names the browser can decode for transcoding; defaults to `isAudioDecodable`. AC-3, E-AC-3, DTS, WMA, MP1/MP2, AMR and ADPCM always have wasm decoders.
	audioDecoders?: readonly string[]
}

export interface LadderVideo {
	codec: string
	codecString: string | null
	width: number
	height: number
	bitDepth?: number | null
	transfer?: "sdr" | "pq" | "hlg" | null
	dolbyVision?: { profile: number } | null
}

export interface LadderAudio {
	codec: string
	codecString: string | null
	channels: number
}

export interface LadderProbe {
	container: string
	video: LadderVideo | null
	audio: readonly LadderAudio[]
}

export type LadderSubtitle = "none" | "sidecar" | "embedded-text" | "embedded-image"

export interface LadderSelection {
	// Index into `probe.audio`, -1 for none.
	audioIndex: number
	subtitle: LadderSubtitle
}

export type LadderReason =
	| "no-video"
	| "video-codec-unknown"
	| "container-not-direct"
	| "container-unsupported"
	| "audio-codec-unknown"
	| "direct-not-playable"
	| "direct-decode-unsupported"
	| "edge-stereo-eac3"
	| "audio-track-needs-remux"
	| "subtitle-needs-remux"
	| "subtitle-image-unsupported"
	| "no-media-source"
	| "remux-video-unsupported"
	| "remux-decode-unsupported"
	| "dolby-vision-profile-5"
	| "audio-not-copyable"
	| "safari-opus-fmp4"
	| "audio-not-transcodable"
	| "no-audio-encoder"

export type AudioPlan =
	| { mode: "none" }
	| { mode: "native" }
	| { mode: "copy" }
	| { mode: "transcode"; target: AudioTarget; codecString: string; channels: 2; sampleRate: 48000; bitrate: number }

export interface LadderDecision {
	path: LadderPath
	reasons: LadderReason[]
	audio: AudioPlan
}

const DIRECT_BASE: Readonly<Record<string, string>> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	// Chrome lacks video/quicktime in canPlayType but plays MOV by sniffing, so it is probed as MP4.
	mov: "video/mp4",
	webm: "video/webm",
	// Ogg Theora/VP8: only a browser that plays it from a plain src (Firefox); nothing remuxes it.
	ogg: "video/ogg"
}

const REMUX_CONTAINERS: ReadonlySet<string> = new Set(["mkv", "webm", "mp4", "m4v", "mov", "ts", "flv", "avi", "asf", "ps"])

// WebCodecs-decodable by name (Mediabunny's vocabulary); PCM variants (pcm-s16, pcm-f32be, ...), u-law and a-law are handled in code.
const WEBCODECS_AUDIO_DECODERS: ReadonlySet<string> = new Set(["aac", "mp3", "opus", "flac", "vorbis"])
// Decoded by FFmpeg built to WebAssembly in the remux worker.
const WASM_AUDIO_DECODERS: ReadonlySet<string> = new Set([
	"ac3",
	"eac3",
	"dts",
	"wma",
	"wmapro",
	"wmalossless",
	"mp1",
	"mp2",
	"amr",
	"amrwb",
	"adpcm"
])
const TARGET_BITRATE = 128_000

const TARGET_MIMES: Readonly<Record<AudioTarget, { mime: string; codecString: string }>> = {
	aac: { mime: "audio/mp4; codecs=\"mp4a.40.2\"", codecString: "mp4a.40.2" },
	"aac-wasm": { mime: "audio/mp4; codecs=\"mp4a.40.2\"", codecString: "mp4a.40.2" },
	opus: { mime: "audio/mp4; codecs=\"opus\"", codecString: "opus" }
}

export function normalizeLadderContainer(container: string): string {
	const value = container.trim().toLowerCase()

	switch (value) {
		case "matroska":
		case "mkv":
		case "mka":
			return "mkv"
		case "quicktime":
		case "qt":
		case "mov":
			return "mov"
		case "mpegts":
		case "mpeg-ts":
		case "m2ts":
		case "mts":
		case "ts":
			return "ts"
		default:
			return value
	}
}

function isDolbyAudio(codec: string): boolean {
	return codec === "ac3" || codec === "eac3"
}

function requiresDecodingInfo(video: LadderVideo): boolean {
	const cs = (video.codecString ?? "").toLowerCase()

	return (
		video.codec === "hevc" ||
		video.codec === "av1" ||
		(video.dolbyVision !== undefined && video.dolbyVision !== null) ||
		video.transfer === "pq" ||
		video.transfer === "hlg" ||
		(video.bitDepth ?? 8) > 8 ||
		cs.startsWith("hvc1") ||
		cs.startsWith("hev1") ||
		cs.startsWith("av01") ||
		cs.startsWith("dvh") ||
		cs.startsWith("dav1")
	)
}

function needsSmooth(video: LadderVideo): boolean {
	return video.codec === "hevc" || video.codec === "av1"
}

function mimes(base: string, video: string | null, audio: string | null): string[] {
	const videos = video === null ? [null] : codecStringAlternatives(video)
	const audios = audio === null ? [null] : codecStringAlternatives(audio)
	const out: string[] = []

	for (const v of videos) {
		for (const a of audios) {
			const list = [v, a].filter((entry): entry is string => entry !== null)

			out.push(list.length === 0 ? base : `${base}; codecs="${list.join(",")}"`)
		}
	}

	return out
}

export interface LadderQueries {
	canPlayType: string[]
	isTypeSupported: string[]
	decodingInfoFile: string[]
	decodingInfoMediaSource: string[]
}

function selectedAudio(probe: LadderProbe, selection: LadderSelection): LadderAudio | null {
	return selection.audioIndex >= 0 ? (probe.audio[selection.audioIndex] ?? null) : null
}

// The MIME strings the browser must be asked about before `decidePlayback`. Results go into the capability maps keyed by these strings.
export function ladderQueries(probe: LadderProbe, selection: LadderSelection): LadderQueries {
	const queries: LadderQueries = {
		canPlayType: [],
		isTypeSupported: [],
		decodingInfoFile: [],
		decodingInfoMediaSource: []
	}
	const video = probe.video

	if (video === null || video.codecString === null) {
		return queries
	}

	const container = normalizeLadderContainer(probe.container)
	const audio = selectedAudio(probe, selection)
	const audioString = audio === null ? null : audio.codecString
	const base = DIRECT_BASE[container]

	if (base !== undefined && (audio === null || audioString !== null)) {
		queries.canPlayType.push(...mimes(base, video.codecString, audioString))
		queries.decodingInfoFile.push(...queries.canPlayType)
	}

	const videoMimes = mimes("video/mp4", video.codecString, null)

	queries.isTypeSupported.push(...videoMimes)

	if (requiresDecodingInfo(video)) {
		queries.decodingInfoMediaSource.push(...videoMimes)
	}

	if (audio !== null && audioString !== null) {
		const audioMimes = mimes("audio/mp4", audioString, null)

		queries.isTypeSupported.push(...audioMimes)

		if (isDolbyAudio(audio.codec)) {
			queries.decodingInfoMediaSource.push(...audioMimes)
		}
	}

	queries.isTypeSupported.push(TARGET_MIMES.aac.mime, TARGET_MIMES.opus.mime)

	return queries
}

function anyTrue(list: readonly string[], map: Readonly<Record<string, boolean>>): boolean {
	return list.some(mime => map[mime] === true)
}

function verdictFor(list: readonly string[], map: Readonly<Record<string, DecodingVerdict>>): DecodingVerdict | null {
	let found: DecodingVerdict | null = null

	for (const mime of list) {
		const verdict = map[mime]

		if (verdict === undefined) {
			continue
		}

		if (verdict.supported) {
			return verdict
		}

		found = verdict
	}

	return found
}

// Whether an audio track can be passed through into fragmented MP4 (also a good `playable` predicate for track choice).
export function isAudioCopyable(audio: LadderAudio, caps: PlaybackCapabilities): boolean {
	if (audio.codecString === null) {
		return false
	}

	if (caps.browser === "safari" && audio.codec === "opus") {
		return false
	}

	if (caps.browser === "edge" && audio.codec === "eac3" && audio.channels <= 2) {
		return false
	}

	const list = mimes("audio/mp4", audio.codecString, null)

	if (!anyTrue(list, caps.isTypeSupported)) {
		return false
	}

	// Chromium's AC-3/E-AC-3 string check is static, so a real decoder query must agree.
	return !isDolbyAudio(audio.codec) || verdictFor(list, caps.decodingInfoMediaSource)?.supported === true
}

function pickAudioTarget(caps: PlaybackCapabilities): AudioTarget | null {
	for (const target of ["aac", "opus", "aac-wasm"] as const) {
		if (!caps.audioEncoders.includes(target)) {
			continue
		}

		// Safari's MSE rejects Opus in fMP4 even though it can encode it.
		if (target === "opus" && caps.browser === "safari") {
			continue
		}

		if (caps.isTypeSupported[TARGET_MIMES[target].mime] === true) {
			return target
		}
	}

	return null
}

function isPcmFamily(codec: string): boolean {
	return codec === "pcm" || codec.startsWith("pcm-") || codec === "ulaw" || codec === "alaw"
}

// Whether an audio codec name can be decoded for transcoding with the default decoder set (WebCodecs, raw PCM, wasm AC-3/E-AC-3/DTS).
// ALAC and TrueHD have no decoder.
export function isAudioDecodable(codec: string): boolean {
	return WASM_AUDIO_DECODERS.has(codec) || WEBCODECS_AUDIO_DECODERS.has(codec) || isPcmFamily(codec)
}

function canDecodeForTranscode(audio: LadderAudio, caps: PlaybackCapabilities): boolean {
	return caps.audioDecoders === undefined
		? isAudioDecodable(audio.codec)
		: WASM_AUDIO_DECODERS.has(audio.codec) || caps.audioDecoders.includes(audio.codec)
}

// Pure playback path decision: direct (service worker range), remux to fMP4 over MSE, remux with audio transcode, video only, or unsupported.
export function decidePlayback(probe: LadderProbe, selection: LadderSelection, caps: PlaybackCapabilities): LadderDecision {
	const video = probe.video

	if (video === null) {
		return {
			path: "unsupported",
			reasons: ["no-video"],
			audio: { mode: "none" }
		}
	}

	if (video.codecString === null) {
		return {
			path: "unsupported",
			reasons: ["video-codec-unknown"],
			audio: { mode: "none" }
		}
	}

	const container = normalizeLadderContainer(probe.container)
	const audio = selectedAudio(probe, selection)
	const reasons: LadderReason[] = []
	const informational: LadderReason[] = selection.subtitle === "embedded-image" ? ["subtitle-image-unsupported"] : []
	const decodingRequired = requiresDecodingInfo(video)

	// Rung A: direct.
	const base = DIRECT_BASE[container]
	const directReasons: LadderReason[] = []

	if (base === undefined) {
		directReasons.push("container-not-direct")
	} else {
		if (container === "mkv") {
			directReasons.push("container-not-direct")
		}

		if (audio !== null && audio.codecString === null) {
			directReasons.push("audio-codec-unknown")
		} else {
			const list = mimes(base, video.codecString, audio === null ? null : audio.codecString)
			const playable = list.some(mime => (caps.canPlayType[mime] ?? "") !== "")
			const verdict = verdictFor(list, caps.decodingInfoFile)
			const mustQuery = decodingRequired || (audio !== null && isDolbyAudio(audio.codec))

			if (!playable) {
				directReasons.push("direct-not-playable")
			}

			if (
				(mustQuery && (verdict === null || !verdict.supported || (needsSmooth(video) && verdict.smooth === false))) ||
				(!mustQuery && verdict !== null && !verdict.supported)
			) {
				directReasons.push("direct-decode-unsupported")
			}
		}

		if (audio !== null && caps.browser === "edge" && audio.codec === "eac3" && audio.channels <= 2) {
			directReasons.push("edge-stereo-eac3")
		}

		if (selection.audioIndex > 0 && !caps.audioTracks) {
			directReasons.push("audio-track-needs-remux")
		}

		if (selection.subtitle === "embedded-text") {
			directReasons.push("subtitle-needs-remux")
		}
	}

	if (directReasons.length === 0) {
		return {
			path: "direct",
			reasons: informational,
			audio: audio === null ? { mode: "none" } : { mode: "native" }
		}
	}

	reasons.push(...directReasons)

	// Rung B: remux into fragmented MP4 for MSE.
	if (!REMUX_CONTAINERS.has(container)) {
		return {
			path: "unsupported",
			reasons: [...reasons, "container-unsupported", ...informational],
			audio: { mode: "none" }
		}
	}

	if (!caps.mediaSource) {
		return {
			path: "unsupported",
			reasons: [...reasons, "no-media-source", ...informational],
			audio: { mode: "none" }
		}
	}

	const videoMimes = mimes("video/mp4", video.codecString, null)
	const mseVerdict = verdictFor(videoMimes, caps.decodingInfoMediaSource)
	const videoSupported = anyTrue(videoMimes, caps.isTypeSupported)
	const decodeOk = decodingRequired ? mseVerdict?.supported === true : mseVerdict === null || mseVerdict.supported

	if (!videoSupported || !decodeOk) {
		reasons.push(
			video.dolbyVision?.profile === 5
				? "dolby-vision-profile-5"
				: !videoSupported
					? "remux-video-unsupported"
					: "remux-decode-unsupported"
		)

		return {
			path: "unsupported",
			reasons: [...reasons, ...informational],
			audio: { mode: "none" }
		}
	}

	if (audio === null) {
		return {
			path: "remux",
			reasons: [...reasons, ...informational],
			audio: { mode: "none" }
		}
	}

	if (isAudioCopyable(audio, caps)) {
		return {
			path: "remux",
			reasons: [...reasons, ...informational],
			audio: { mode: "copy" }
		}
	}

	reasons.push(audio.codecString === null ? "audio-codec-unknown" : "audio-not-copyable")

	if (caps.browser === "safari" && audio.codec === "opus") {
		reasons.push("safari-opus-fmp4")
	}

	// Rung C: decode + re-encode to stereo 48 kHz.
	if (!canDecodeForTranscode(audio, caps)) {
		return {
			path: "video-only",
			reasons: [...reasons, "audio-not-transcodable", ...informational],
			audio: { mode: "none" }
		}
	}

	const target = pickAudioTarget(caps)

	if (target === null) {
		return {
			path: "video-only",
			reasons: [...reasons, "no-audio-encoder", ...informational],
			audio: { mode: "none" }
		}
	}

	return {
		path: "remux+transcode",
		reasons: [...reasons, ...informational],
		audio: {
			mode: "transcode",
			target,
			codecString: TARGET_MIMES[target].codecString,
			channels: 2,
			sampleRate: 48000,
			bitrate: TARGET_BITRATE
		}
	}
}
