import { type } from "arktype"
import {
	codecStringAlternatives,
	decidePlayback,
	normalizeLadderContainer,
	type DecodingVerdict,
	type LadderBrowser,
	type LadderDecision,
	type LadderPath,
	type LadderProbe,
	type LadderSelection,
	type PlaybackCapabilities,
	type VideoProbe
} from "@filen/shared/videos"
import type { PlaybackTrigger } from "@/lib/media/playback/types"

// The decisions behind playback capability probing and runtime demotion, as pure functions.

export function ladderBrowser(userAgent: string): LadderBrowser {
	if (/Edg(e|A|iOS)?\//.test(userAgent)) {
		return "edge"
	}

	if (userAgent.includes("Firefox/") && !userAgent.includes("FxiOS")) {
		return "firefox"
	}

	// Every iOS browser is WebKit.
	if (/CriOS|FxiOS|iPhone|iPad/.test(userAgent)) {
		return "safari"
	}

	if (/Chrome\/|Chromium\//.test(userAgent)) {
		return "chrome"
	}

	return userAgent.includes("Safari/") ? "safari" : "other"
}

export function toLadderProbe(probe: VideoProbe): LadderProbe {
	const video = probe.video

	return {
		container: probe.container,
		video:
			video === null
				? null
				: {
						codec: video.codec ?? video.fourcc,
						codecString: video.codecString,
						width: video.w,
						height: video.h,
						bitDepth: video.bitDepth,
						transfer: video.transfer,
						dolbyVision: video.dv === undefined ? null : { profile: video.dv.profile }
					},
		audio: probe.audio.map(audio => ({
			codec: audio.codec ?? "",
			codecString: audio.codecString,
			channels: audio.ch ?? 2
		}))
	}
}

// What decodingInfo is told about the streams besides their MIME types; hints, not verdicts.
export interface StreamFacts {
	width: number
	height: number
	// Bits per second over the whole file.
	bitrate: number
	framerate: number
	transfer: "sdr" | "pq" | "hlg" | null
	channels: number
	sampleRate: number
}

const DEFAULT_BITRATE = 8_000_000
const DEFAULT_FRAMERATE = 30
const DEFAULT_SAMPLE_RATE = 48_000

export function streamFacts(params: { probe: VideoProbe; selection: LadderSelection; size: number }): StreamFacts {
	const { probe, selection, size } = params
	const audio = selection.audioIndex >= 0 ? probe.audio[selection.audioIndex] : undefined
	const duration = probe.durationSec ?? 0

	return {
		width: probe.video?.w ?? 0,
		height: probe.video?.h ?? 0,
		bitrate: duration > 0 && size > 0 ? Math.round((size * 8) / duration) : DEFAULT_BITRATE,
		framerate: DEFAULT_FRAMERATE,
		transfer: probe.video?.transfer ?? null,
		channels: audio?.ch ?? 2,
		sampleRate: audio?.rate ?? DEFAULT_SAMPLE_RATE
	}
}

export function splitMime(mime: string): { base: string; codecs: string[] } {
	const [base = "", ...params] = mime.split(";")
	const codecs = params.map(param => /^\s*codecs\s*=\s*"?([^"]*)"?\s*$/i.exec(param)?.[1]).find(value => value !== undefined)

	return {
		base: base.trim().toLowerCase(),
		codecs:
			codecs === undefined
				? []
				: codecs
						.split(",")
						.map(codec => codec.trim())
						.filter(codec => codec !== "")
	}
}

// The decodingInfo query for one of the ladder's MIME strings: a video and/or an audio configuration, one
// codec each (MediaCapabilities refuses a contentType listing two). Null when the MIME names no codec.
export function decodingConfiguration(params: {
	mime: string
	type: "file" | "media-source"
	facts: StreamFacts
}): MediaDecodingConfiguration | null {
	const { mime, type, facts } = params
	const { base, codecs } = splitMime(mime)
	const [first, second] = codecs

	if (first === undefined) {
		return null
	}

	const container = base.slice(base.indexOf("/") + 1)
	const video = (codec: string): VideoConfiguration => ({
		contentType: `video/${container}; codecs="${codec}"`,
		width: Math.max(1, facts.width),
		height: Math.max(1, facts.height),
		bitrate: facts.bitrate,
		framerate: facts.framerate,
		...(facts.transfer === "pq" || facts.transfer === "hlg" ? { transferFunction: facts.transfer } : {})
	})
	const audio = (codec: string): AudioConfiguration => ({
		contentType: `audio/${container}; codecs="${codec}"`,
		channels: String(facts.channels),
		samplerate: facts.sampleRate
	})

	if (base.startsWith("audio/")) {
		return { type, audio: audio(first) }
	}

	return second === undefined ? { type, video: video(first) } : { type, video: video(first), audio: audio(second) }
}

// decodingInfo answers depend on the configuration only, so one answer serves every file asking the same.
export function decodingKey(configuration: MediaDecodingConfiguration): string {
	const { type, video, audio } = configuration

	return JSON.stringify([
		type,
		video === undefined ? null : [video.contentType, video.width, video.height, video.framerate, video.transferFunction ?? null],
		audio === undefined ? null : [audio.contentType, audio.channels ?? null, audio.samplerate ?? null]
	])
}

export function decodingVerdict(info: { supported: boolean; smooth: boolean }): DecodingVerdict {
	return { supported: info.supported, smooth: info.smooth }
}

// ── Learned demotions ────────────────────────────────────────────────────────────────────────────

// One kv row per browser build: a new user agent starts over, and the old row is dropped.
export const DEMOTION_KV_PREFIX = "video.cap.v1:"
export const DEMOTION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// More distinct failing configurations than this on one browser build means something else is wrong.
export const MAX_LEARNED_DEMOTIONS = 64

// `files`: hashes of the files the configuration failed on (a lower rung then played each of them). One
// file can be at fault itself; a second, different one makes it the browser.
export const learnedDemotionSchema = type({
	sig: "string",
	reason: "'media-error' | 'no-first-frame' | 'decode-stall' | 'silent-audio'",
	at: "number",
	files: "string[]"
})

export type LearnedDemotion = typeof learnedDemotionSchema.infer

export const learnedDemotionsSchema = learnedDemotionSchema.array()

// Files a configuration must have failed on before it is skipped up front.
export const DEMOTION_CONFIRMING_FILES = 2

export function isConfirmedDemotion(record: LearnedDemotion): boolean {
	return record.files.length >= DEMOTION_CONFIRMING_FILES
}

// `record` with one more file it failed on (the newest few kept), now.
export function recordDemotion(params: {
	record: LearnedDemotion | null
	sig: string
	reason: LearnedDemotion["reason"]
	fileKey: string
	now: number
}): LearnedDemotion {
	const { record, sig, reason, fileKey, now } = params
	const files = [...(record?.files ?? []).filter(file => file !== fileKey), fileKey].slice(-DEMOTION_CONFIRMING_FILES)

	return { sig, reason, at: now, files }
}

export function demotionKvKey(userAgent: string): string {
	return `${DEMOTION_KV_PREFIX}${userAgent}`
}

// Rows written under another user agent: the browser changed since, and what it could not play then says
// nothing about now.
export function staleDemotionKeys(keys: readonly string[], userAgent: string): string[] {
	const current = demotionKvKey(userAgent)

	return keys.filter(key => key !== current)
}

// The demotions still in force: younger than the TTL, the latest per signature, the newest
// MAX_LEARNED_DEMOTIONS.
export function liveDemotions(records: readonly LearnedDemotion[], now: number): LearnedDemotion[] {
	const latest = new Map<string, LearnedDemotion>()

	for (const record of records) {
		if (now - record.at >= DEMOTION_TTL_MS || record.at > now) {
			continue
		}

		const known = latest.get(record.sig)

		if (known === undefined || known.at < record.at) {
			latest.set(record.sig, record)
		}
	}

	return [...latest.values()].sort((a, b) => b.at - a.at).slice(0, MAX_LEARNED_DEMOTIONS)
}

// Triggers that say what the browser cannot do, worth remembering. The rest describe the file (keyframe
// interval, open GOP), the connection (network, no metadata in time, no service worker) or a transient
// fault (worker).
const LEARNED_TRIGGERS: ReadonlySet<PlaybackTrigger> = new Set(["media-error", "no-first-frame", "decode-stall", "silent-audio"])

export type LearnedTrigger = LearnedDemotion["reason"]

export function isLearnedTrigger(trigger: PlaybackTrigger): trigger is LearnedTrigger {
	return LEARNED_TRIGGERS.has(trigger)
}

// Rung signatures a whole rung can be given up on by, for this playback only: a direct stream that failed
// fails with any audio track, and so does a picture that never showed.
export function pathWideKey(path: LadderPath): string {
	return `${path}|*`
}

export function isPathWide(path: LadderPath, trigger: PlaybackTrigger): boolean {
	return path === "direct" || triggerTarget(trigger) === "video"
}

// Triggers no lower rung can help with.
const TERMINAL_TRIGGERS: ReadonlySet<PlaybackTrigger> = new Set(["network", "keyframe-interval", "open-gop-start"])

export function isTerminalTrigger(trigger: PlaybackTrigger): boolean {
	return TERMINAL_TRIGGERS.has(trigger)
}

// Which stream a trigger points at: one that cannot tell is treated by where the rung differs from the
// next one down.
type TriggerTarget = "video" | "audio" | "either"

function triggerTarget(trigger: PlaybackTrigger): TriggerTarget {
	switch (trigger) {
		case "silent-audio":
			return "audio"
		case "no-first-frame":
			return "video"
		default:
			return "either"
	}
}

// The configuration a demotion is remembered for: the rung and the codecs it failed with.
export function demotionSignature(params: { path: LadderPath; probe: LadderProbe; selection: LadderSelection }): string {
	const { path, probe, selection } = params
	const audio = selection.audioIndex >= 0 ? probe.audio[selection.audioIndex] : undefined

	return [
		path,
		normalizeLadderContainer(probe.container),
		probe.video?.codecString ?? "-",
		path === "video-only" || audio === undefined ? "-" : (audio.codecString ?? audio.codec)
	].join("|")
}

function mp4Mimes(kind: "video" | "audio", codecString: string | null): string[] {
	return codecString === null ? [] : codecStringAlternatives(codecString).map(codec => `${kind}/mp4; codecs="${codec}"`)
}

function withTypeSupport(caps: PlaybackCapabilities, mimes: readonly string[]): PlaybackCapabilities {
	const isTypeSupported = { ...caps.isTypeSupported }

	for (const mime of mimes) {
		isTypeSupported[mime] = false
	}

	return { ...caps, isTypeSupported }
}

// The capabilities with the decision's rung taken away, so deciding again lands on the next one down;
// null when there is none below. `trigger` picks the stream to give up on where a rung has two ways down.
export function demoteCapabilities(params: {
	caps: PlaybackCapabilities
	probe: LadderProbe
	selection: LadderSelection
	decision: LadderDecision
	trigger: PlaybackTrigger
}): PlaybackCapabilities | null {
	const { caps, probe, selection, decision, trigger } = params
	const target = triggerTarget(trigger)
	const audio = selection.audioIndex >= 0 ? (probe.audio[selection.audioIndex] ?? null) : null
	const videoMimes = mp4Mimes("video", probe.video?.codecString ?? null)

	switch (decision.path) {
		case "direct":
			return withoutDirect(caps)
		case "remux":
			if (decision.audio.mode === "copy" && audio !== null && target !== "video") {
				return withTypeSupport(caps, mp4Mimes("audio", audio.codecString))
			}

			return withTypeSupport(caps, videoMimes)
		case "remux+transcode":
			return target === "video" ? withTypeSupport(caps, videoMimes) : { ...caps, audioEncoders: [] }
		case "video-only":
			return withTypeSupport(caps, videoMimes)
		case "unsupported":
			return null
	}
}

// The capabilities without the direct rung: nothing can stream it (no service worker controls the page).
export function withoutDirect(caps: PlaybackCapabilities): PlaybackCapabilities {
	return { ...caps, canPlayType: Object.fromEntries(Object.keys(caps.canPlayType).map(mime => [mime, ""])) }
}

function sameRung(a: LadderDecision, b: LadderDecision): boolean {
	return a.path === b.path && a.audio.mode === b.audio.mode
}

// The decision one rung below `decision`, with the capabilities that lead there; null when nothing below
// plays. A way down that changes nothing (the stream it gave up on was not the one deciding) gives up on
// the video as well.
export function demote(params: {
	caps: PlaybackCapabilities
	probe: LadderProbe
	selection: LadderSelection
	decision: LadderDecision
	trigger: PlaybackTrigger
}): { decision: LadderDecision; caps: PlaybackCapabilities } | null {
	const { probe, selection } = params
	const caps = demoteCapabilities(params)

	if (caps === null) {
		return null
	}

	const decision = decidePlayback(probe, selection, caps)

	if (!sameRung(decision, params.decision)) {
		return { decision, caps }
	}

	const withoutVideo = withTypeSupport(caps, mp4Mimes("video", probe.video?.codecString ?? null))
	const lower = decidePlayback(probe, selection, withoutVideo)

	return sameRung(lower, params.decision) ? null : { decision: lower, caps: withoutVideo }
}

// The decision with every known demotion applied: each one that matches the rung the ladder lands on
// (by signature, or rung-wide via pathWideKey) takes that rung away, until one matches none.
export function decideWithDemotions(params: {
	probe: LadderProbe
	selection: LadderSelection
	caps: PlaybackCapabilities
	learned: ReadonlyMap<string, { reason: PlaybackTrigger }>
}): { decision: LadderDecision; caps: PlaybackCapabilities; demoted: string[] } {
	const { probe, selection, learned } = params
	let caps = params.caps
	let decision = decidePlayback(probe, selection, caps)
	const demoted: string[] = []

	// Every rung at most once.
	for (let step = 0; step < 5 && decision.path !== "unsupported"; step++) {
		const sig = demotionSignature({ path: decision.path, probe, selection })
		const record = learned.get(sig) ?? learned.get(pathWideKey(decision.path))

		if (record === undefined) {
			break
		}

		const next = demote({ caps, probe, selection, decision, trigger: record.reason })

		if (next === null) {
			break
		}

		demoted.push(sig)
		caps = next.caps
		decision = next.decision
	}

	return { decision, caps, demoted }
}

// ── Encoders ─────────────────────────────────────────────────────────────────────────────────────

// What the browser can encode, for an editor's export. Asked once per browser build (one kv row per user agent, the
// old row dropped) and only when an editor asks: on Firefox an answer means encoding a frame, since its
// isConfigSupported is unreliable. Probed at 1080p, the export's default ceiling, with no hardware preference.
export const ENCODE_CAPS_KV_PREFIX = "video.enc.v1:"

export const ENCODE_PROBE_WIDTH = 1920
export const ENCODE_PROBE_HEIGHT = 1080

// HEVC Main 10 (profile 2, compatibility flag 2), level 4.1, main tier: the 10-bit target that keeps HDR.
export const HEVC_MAIN10_CODEC_STRING = "hvc1.2.4.L123.B0"

// Video codecs an export may pick, in order of preference for an MP4 output.
export const EXPORT_VIDEO_CODECS = ["avc", "hevc", "vp9", "av1"] as const

export const encodeCapabilitiesSchema = type({
	// WebCodecs encoders exist at all (VideoEncoder, AudioEncoder); without them only the copy path is possible.
	videoEncoder: "boolean",
	audioEncoder: "boolean",
	video: {
		avc: "boolean",
		hevc: "boolean",
		hevcMain10: "boolean",
		vp9: "boolean",
		av1: "boolean"
	},
	// The first of EXPORT_VIDEO_CODECS the browser encodes.
	firstVideoCodec: "'avc' | 'hevc' | 'vp9' | 'av1' | null",
	audio: {
		aac: "boolean",
		opus: "boolean"
	}
})

export type EncodeCapabilities = typeof encodeCapabilitiesSchema.infer

export const NO_ENCODERS: EncodeCapabilities = {
	videoEncoder: false,
	audioEncoder: false,
	video: { avc: false, hevc: false, hevcMain10: false, vp9: false, av1: false },
	firstVideoCodec: null,
	audio: { aac: false, opus: false }
}

export function encodeCapsKvKey(userAgent: string): string {
	return `${ENCODE_CAPS_KV_PREFIX}${userAgent}`
}

// Rows written under another user agent: the browser changed since.
export function staleEncodeCapsKeys(keys: readonly string[], userAgent: string): string[] {
	const current = encodeCapsKvKey(userAgent)

	return keys.filter(key => key !== current)
}
