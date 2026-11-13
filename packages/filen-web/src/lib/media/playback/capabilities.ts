import {
	ladderQueries,
	type AudioTarget,
	type DecodingVerdict,
	type LadderProbe,
	type LadderSelection,
	type PlaybackCapabilities
} from "@filen/shared/videos"
import {
	decodingConfiguration,
	decodingKey,
	decodingVerdict,
	demotionKvKey,
	DEMOTION_KV_PREFIX,
	ENCODE_CAPS_KV_PREFIX,
	encodeCapabilitiesSchema,
	encodeCapsKvKey,
	NO_ENCODERS,
	staleEncodeCapsKeys,
	type EncodeCapabilities,
	isConfirmedDemotion,
	isLearnedTrigger,
	ladderBrowser,
	learnedDemotionsSchema,
	liveDemotions,
	recordDemotion,
	staleDemotionKeys,
	type LearnedDemotion,
	type StreamFacts
} from "@/lib/media/playback/capabilities.logic"
import type { PlaybackTrigger } from "@/lib/media/playback/types"
import { kvDelete, kvGetJson, kvKeys, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import { probeEncodersInWorker } from "@/lib/media/remuxClient"

// What the browser can play, asked once per session for the environment and per file for its codecs.
// canPlayType and isTypeSupported are synchronous and cheap, so they are asked every time; decodingInfo
// and AudioEncoder.isConfigSupported go to the platform's decoders and encoders, so their answers are
// kept for the session. Only demotions learned at runtime are persisted, and the encoders an editor's export can use
// (asked only when an editor asks, once per browser build).

export type FullscreenKind = "element" | "video" | "none"

export interface PlaybackEnvironment {
	browser: ReturnType<typeof ladderBrowser>
	// MediaSource wherever it exists; ManagedMediaSource only where it does not (iPhone).
	mediaSource: "MediaSource" | "ManagedMediaSource" | null
	audioEncoder: boolean
	videoDecoder: boolean
	// "video": only the <video> element's own fullscreen (webkitEnterFullscreen, iPhone).
	fullscreen: FullscreenKind
	wakeLock: boolean
	pictureInPicture: boolean
	// HTMLMediaElement.audioTracks (Safari): a direct stream can switch audio tracks itself.
	audioTracks: boolean
	// requestVideoFrameCallback, which the first-frame watchdog needs.
	frameCallback: boolean
}

interface MediaSourceStatic {
	isTypeSupported(type: string): boolean
}

interface PlatformGlobals {
	MediaSource?: MediaSourceStatic
	ManagedMediaSource?: MediaSourceStatic
	AudioEncoder?: { isConfigSupported(config: AudioEncoderConfig): Promise<{ supported?: boolean }> }
	VideoDecoder?: unknown
}

interface WebKitVideoElement {
	webkitEnterFullscreen?: () => void
	webkitSupportsPresentationMode?: (mode: string) => boolean
}

function platform(): PlatformGlobals {
	return globalThis
}

function mediaSourceStatic(): MediaSourceStatic | null {
	return platform().MediaSource ?? platform().ManagedMediaSource ?? null
}

function detectEnvironment(): PlaybackEnvironment {
	const globals = platform()
	const video = document.createElement("video")
	const webkitVideo: HTMLVideoElement & WebKitVideoElement = video
	const fullscreen: FullscreenKind =
		document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled === true
			? "element"
			: typeof webkitVideo.webkitEnterFullscreen === "function"
				? "video"
				: "none"

	return {
		browser: ladderBrowser(navigator.userAgent),
		mediaSource:
			globals.MediaSource !== undefined ? "MediaSource" : globals.ManagedMediaSource !== undefined ? "ManagedMediaSource" : null,
		audioEncoder: globals.AudioEncoder !== undefined,
		videoDecoder: globals.VideoDecoder !== undefined,
		fullscreen,
		wakeLock: "wakeLock" in navigator,
		pictureInPicture: document.pictureInPictureEnabled || typeof webkitVideo.webkitSupportsPresentationMode === "function",
		audioTracks: "audioTracks" in HTMLMediaElement.prototype,
		frameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype
	}
}

let environment: PlaybackEnvironment | null = null

// Probed once per page.
export function playbackEnvironment(): PlaybackEnvironment {
	environment ??= detectEnvironment()

	return environment
}

// The re-encode targets in the ladder's order, with the configuration the remux worker encodes with.
const ENCODER_TARGETS: readonly { target: AudioTarget; codec: string }[] = [
	{ target: "aac", codec: "mp4a.40.2" },
	{ target: "opus", codec: "opus" }
]
const ENCODER_CONFIG = { sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 }

export interface CapabilityKv {
	get(key: string): Promise<LearnedDemotion[] | null>
	set(key: string, value: LearnedDemotion[]): Promise<void>
	keys(prefix: string): Promise<string[]>
	delete(key: string): Promise<void>
}

export interface EncodeCapabilityKv {
	get(key: string): Promise<EncodeCapabilities | null>
	set(key: string, value: EncodeCapabilities): Promise<void>
	keys(prefix: string): Promise<string[]>
	delete(key: string): Promise<void>
}

export interface CapabilityDeps {
	environment(): PlaybackEnvironment
	userAgent: string
	canPlayType(mime: string): string
	isTypeSupported(mime: string): boolean
	decodingInfo(configuration: MediaDecodingConfiguration): Promise<{ supported: boolean; smooth: boolean }>
	isEncoderSupported(config: AudioEncoderConfig): Promise<boolean>
	kv: CapabilityKv
	// Runs the encoder checks (mediabunny's, in the remux worker).
	probeEncoders(): Promise<EncodeCapabilities>
	encodeKv: EncodeCapabilityKv
	now(): number
}

export class PlaybackCapabilityProbe {
	private readonly deps: CapabilityDeps
	private readonly decodings = new Map<string, Promise<DecodingVerdict | null>>()
	private encoders: Promise<AudioTarget[]> | null = null
	private exportEncoders: Promise<EncodeCapabilities> | null = null
	private learnedLoad: Promise<Map<string, LearnedDemotion>> | null = null
	// The stored demotions could not be read: they are left alone rather than overwritten.
	private loadFailed = false

	private get learnedMap(): Promise<Map<string, LearnedDemotion>> {
		this.learnedLoad ??= this.loadLearned()

		return this.learnedLoad
	}

	public constructor(deps: CapabilityDeps) {
		this.deps = deps
	}

	// Everything decidePlayback needs for `probe` with `selection`.
	public async capabilities(probe: LadderProbe, selection: LadderSelection, facts: StreamFacts): Promise<PlaybackCapabilities> {
		const env = this.deps.environment()
		const queries = ladderQueries(probe, selection)
		const canPlayType: Record<string, string> = {}
		const isTypeSupported: Record<string, boolean> = {}

		for (const mime of queries.canPlayType) {
			canPlayType[mime] = this.deps.canPlayType(mime)
		}

		if (env.mediaSource !== null) {
			for (const mime of queries.isTypeSupported) {
				isTypeSupported[mime] = this.deps.isTypeSupported(mime)
			}
		}

		const verdicts = async (mimes: readonly string[], type: "file" | "media-source"): Promise<Record<string, DecodingVerdict>> => {
			const answers = await Promise.all(mimes.map(mime => this.decoding(mime, type, facts)))
			const out: Record<string, DecodingVerdict> = {}

			mimes.forEach((mime, index) => {
				const answer = answers[index]

				if (answer !== undefined && answer !== null) {
					out[mime] = answer
				}
			})

			return out
		}
		// A type the browser already refuses needs no decoder verdict.
		const [decodingInfoFile, decodingInfoMediaSource, audioEncoders] = await Promise.all([
			verdicts(
				queries.decodingInfoFile.filter(mime => (canPlayType[mime] ?? "") !== ""),
				"file"
			),
			verdicts(
				queries.decodingInfoMediaSource.filter(mime => isTypeSupported[mime] === true),
				"media-source"
			),
			this.audioEncoders()
		])

		return {
			browser: env.browser,
			mediaSource: env.mediaSource !== null,
			audioTracks: env.audioTracks,
			canPlayType,
			isTypeSupported,
			decodingInfoFile,
			decodingInfoMediaSource,
			audioEncoders
		}
	}

	// The demotions learned on this browser build that are still in force and confirmed (failed on
	// DEMOTION_CONFIRMING_FILES different files), by signature.
	public async learned(): Promise<ReadonlyMap<string, LearnedDemotion>> {
		const map = await this.learnedMap

		return new Map([...map].filter(([, record]) => isConfirmedDemotion(record)))
	}

	// Remembers that `sig` failed on the file `fileKey` with `trigger` (only triggers that describe the
	// browser). Read, changed and written back per call, so what another tab learned meanwhile is kept;
	// nothing is written when the stored record could not be read, rather than overwrite it.
	public async learn(sig: string, trigger: PlaybackTrigger, fileKey: string): Promise<void> {
		if (!isLearnedTrigger(trigger)) {
			return
		}

		const map = await this.learnedMap

		if (this.loadFailed) {
			return
		}

		const { kv, userAgent } = this.deps
		const key = demotionKvKey(userAgent)
		const now = this.deps.now()

		try {
			const stored = liveDemotions((await kv.get(key)) ?? [], now)
			const record = recordDemotion({ record: stored.find(row => row.sig === sig) ?? null, sig, reason: trigger, fileKey, now })
			const live = liveDemotions([...stored.filter(row => row.sig !== sig), record], now)

			map.clear()

			for (const row of live) {
				map.set(row.sig, row)
			}

			await kv.set(key, live)
		} catch (error) {
			log.warn("playback", "failed to persist a learned demotion", error)
		}
	}

	// The encoders an editor's export can use: the stored answer for this browser build, else probed once and stored.
	// A probe that failed (the worker died) answers no encoders for now and is asked again next time.
	public encodeCapabilities(): Promise<EncodeCapabilities> {
		this.exportEncoders ??= this.loadEncodeCapabilities()

		return this.exportEncoders
	}

	private async loadEncodeCapabilities(): Promise<EncodeCapabilities> {
		const { encodeKv, userAgent } = this.deps
		const key = encodeCapsKvKey(userAgent)
		const stored = await encodeKv.get(key).catch((error: unknown) => {
			log.warn("playback", "failed to read the stored encoder capabilities", error)

			return null
		})

		if (stored !== null) {
			return stored
		}

		let probed: EncodeCapabilities

		try {
			probed = await this.deps.probeEncoders()
		} catch (error) {
			log.warn("playback", "encoder probe failed", error)
			this.exportEncoders = null

			return NO_ENCODERS
		}

		try {
			const keys = await encodeKv.keys(ENCODE_CAPS_KV_PREFIX)

			await Promise.all([encodeKv.set(key, probed), ...staleEncodeCapsKeys(keys, userAgent).map(stale => encodeKv.delete(stale))])
		} catch (error) {
			log.warn("playback", "failed to store the encoder capabilities", error)
		}

		return probed
	}

	private decoding(mime: string, type: "file" | "media-source", facts: StreamFacts): Promise<DecodingVerdict | null> {
		const configuration = decodingConfiguration({ mime, type, facts })

		if (configuration === null) {
			return Promise.resolve(null)
		}

		const key = decodingKey(configuration)
		let answer = this.decodings.get(key)

		if (answer === undefined) {
			// A query the browser cannot answer (a field it rejects, no MediaCapabilities) is no verdict.
			answer = this.deps
				.decodingInfo(configuration)
				.then(decodingVerdict)
				.catch(() => null)
			this.decodings.set(key, answer)
		}

		return answer
	}

	private audioEncoders(): Promise<AudioTarget[]> {
		this.encoders ??= Promise.all(
			ENCODER_TARGETS.map(async ({ target, codec }) =>
				(await this.deps.isEncoderSupported({ codec, ...ENCODER_CONFIG }).catch(() => false)) ? target : null
			)
		).then(targets => targets.filter((target): target is AudioTarget => target !== null))

		return this.encoders
	}

	private async loadLearned(): Promise<Map<string, LearnedDemotion>> {
		const { kv, userAgent } = this.deps

		try {
			const [records, keys] = await Promise.all([kv.get(demotionKvKey(userAgent)), kv.keys(DEMOTION_KV_PREFIX)])

			await Promise.all(staleDemotionKeys(keys, userAgent).map(key => kv.delete(key)))

			return new Map(liveDemotions(records ?? [], this.deps.now()).map(record => [record.sig, record]))
		} catch (error) {
			log.warn("playback", "failed to load learned demotions", error)
			this.loadFailed = true

			return new Map()
		}
	}
}

let probeElement: HTMLVideoElement | null = null

function canPlayType(mime: string): string {
	probeElement ??= document.createElement("video")

	return probeElement.canPlayType(mime)
}

export const playbackCapabilities = new PlaybackCapabilityProbe({
	environment: playbackEnvironment,
	userAgent: navigator.userAgent,
	canPlayType,
	isTypeSupported: mime => mediaSourceStatic()?.isTypeSupported(mime) ?? false,
	decodingInfo: configuration => navigator.mediaCapabilities.decodingInfo(configuration),
	isEncoderSupported: async config => {
		const encoder = platform().AudioEncoder

		return encoder !== undefined && (await encoder.isConfigSupported(config)).supported === true
	},
	kv: {
		get: key => kvGetJson(key, learnedDemotionsSchema),
		set: (key, value) => kvSetJson(key, value),
		keys: kvKeys,
		delete: kvDelete
	},
	probeEncoders: probeEncodersInWorker,
	encodeKv: {
		get: key => kvGetJson(key, encodeCapabilitiesSchema),
		set: (key, value) => kvSetJson(key, value),
		keys: kvKeys,
		delete: kvDelete
	},
	now: () => Date.now()
})
