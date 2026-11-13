import { describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import type { LadderProbe, LadderSelection, VideoProbe } from "@filen/shared/videos"
import {
	decodingConfiguration,
	decodingKey,
	DEMOTION_KV_PREFIX,
	DEMOTION_TTL_MS,
	demotionKvKey,
	ENCODE_CAPS_KV_PREFIX,
	encodeCapabilitiesSchema,
	encodeCapsKvKey,
	NO_ENCODERS,
	type EncodeCapabilities,
	isConfirmedDemotion,
	recordDemotion,
	ladderBrowser,
	liveDemotions,
	splitMime,
	staleDemotionKeys,
	streamFacts,
	toLadderProbe,
	type LearnedDemotion,
	type StreamFacts
} from "@/lib/media/playback/capabilities.logic"
import { PlaybackCapabilityProbe, type CapabilityDeps, type PlaybackEnvironment } from "@/lib/media/playback/capabilities"

const UA = "Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/157.0"
const DAY = 24 * 60 * 60 * 1000

const FACTS: StreamFacts = {
	width: 1920,
	height: 1080,
	bitrate: 8_000_000,
	framerate: 30,
	transfer: "sdr",
	channels: 2,
	sampleRate: 48_000
}

function videoProbe(overrides: Partial<VideoProbe> = {}): VideoProbe {
	return {
		v: 1,
		container: "mp4",
		durationSec: 100,
		index: "moov",
		video: {
			codec: "hevc",
			fourcc: "hvc1",
			codecString: "hvc1.1.6.L120.90",
			w: 1920,
			h: 1080,
			par: 1,
			rotation: 0,
			bitDepth: 10,
			transfer: "pq"
		},
		audio: [
			{
				id: 2,
				codec: "aac",
				codecString: "mp4a.40.2",
				ch: 6,
				rate: 44_100,
				lang: "en",
				name: null,
				def: true,
				forced: false,
				commentary: false
			},
			{
				id: 3,
				codec: "ac3",
				codecString: "ac-3",
				ch: null,
				rate: null,
				lang: "de",
				name: null,
				def: false,
				forced: false,
				commentary: false
			}
		],
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false,
		...overrides
	}
}

describe("ladderBrowser", () => {
	it.each([
		["Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36", "chrome"],
		["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36 Edg/155.0", "edge"],
		[UA, "firefox"],
		["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15", "safari"],
		["Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1", "safari"],
		["Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/157.0 Mobile/15E148 Safari/605.1.15", "safari"],
		["curl/8", "other"]
	])("%s -> %s", (userAgent, browser) => {
		expect(ladderBrowser(userAgent)).toBe(browser)
	})
})

describe("toLadderProbe / streamFacts", () => {
	it("maps the container probe onto the ladder's input", () => {
		expect(toLadderProbe(videoProbe())).toEqual({
			container: "mp4",
			video: {
				codec: "hevc",
				codecString: "hvc1.1.6.L120.90",
				width: 1920,
				height: 1080,
				bitDepth: 10,
				transfer: "pq",
				dolbyVision: null
			},
			audio: [
				{ codec: "aac", codecString: "mp4a.40.2", channels: 6 },
				{ codec: "ac3", codecString: "ac-3", channels: 2 }
			]
		})
	})

	it("derives the bitrate from size and duration, and the audio facts from the selected track", () => {
		expect(streamFacts({ probe: videoProbe(), selection: { audioIndex: 0, subtitle: "none" }, size: 100_000_000 })).toEqual({
			width: 1920,
			height: 1080,
			bitrate: 8_000_000,
			framerate: 30,
			transfer: "pq",
			channels: 6,
			sampleRate: 44_100
		})
		expect(
			streamFacts({ probe: videoProbe({ durationSec: null }), selection: { audioIndex: 1, subtitle: "none" }, size: 1 })
		).toMatchObject({
			bitrate: 8_000_000,
			channels: 2,
			sampleRate: 48_000
		})
	})
})

describe("decodingConfiguration", () => {
	it("splits a two-codec MIME into one video and one audio configuration", () => {
		expect(splitMime('video/mp4; codecs="avc1.64001f,mp4a.40.2"')).toEqual({ base: "video/mp4", codecs: ["avc1.64001f", "mp4a.40.2"] })
		expect(decodingConfiguration({ mime: 'video/webm; codecs="vp09.00.10.08,opus"', type: "file", facts: FACTS })).toEqual({
			type: "file",
			video: { contentType: 'video/webm; codecs="vp09.00.10.08"', width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 },
			audio: { contentType: 'audio/webm; codecs="opus"', channels: "2", samplerate: 48_000 }
		})
	})

	it("asks about HDR transfer and single-stream MIMEs, and skips a MIME without codecs", () => {
		const hdr = decodingConfiguration({
			mime: 'video/mp4; codecs="hvc1.2.4.L120.90"',
			type: "media-source",
			facts: { ...FACTS, transfer: "pq" }
		})

		expect(hdr?.video?.transferFunction).toBe("pq")
		expect(hdr?.audio).toBeUndefined()
		expect(decodingConfiguration({ mime: 'audio/mp4; codecs="ec-3"', type: "media-source", facts: FACTS })).toEqual({
			type: "media-source",
			audio: { contentType: 'audio/mp4; codecs="ec-3"', channels: "2", samplerate: 48_000 }
		})
		expect(decodingConfiguration({ mime: "video/mp4", type: "file", facts: FACTS })).toBeNull()
	})

	it("keys an answer by what decides it, not by the file's bitrate", () => {
		const a = decodingConfiguration({ mime: 'video/mp4; codecs="hvc1.1.6.L120.90"', type: "file", facts: FACTS })
		const b = decodingConfiguration({ mime: 'video/mp4; codecs="hvc1.1.6.L120.90"', type: "file", facts: { ...FACTS, bitrate: 1 } })
		const c = decodingConfiguration({ mime: 'video/mp4; codecs="hvc1.1.6.L120.90"', type: "media-source", facts: FACTS })

		if (a === null || b === null || c === null) {
			throw new Error("no configuration")
		}

		expect(decodingKey(a)).toBe(decodingKey(b))
		expect(decodingKey(a)).not.toBe(decodingKey(c))
	})
})

describe("learned demotions", () => {
	const record = (sig: string, at: number): LearnedDemotion => ({ sig, reason: "media-error", at, files: ["f1"] })

	it("keeps only the latest record per signature younger than the TTL", () => {
		const now = 100 * DAY

		expect(
			liveDemotions(
				[record("a", now - DEMOTION_TTL_MS), record("b", now - DAY), record("b", now - 2 * DAY), record("c", now + DAY)],
				now
			)
		).toEqual([record("b", now - DAY)])
	})

	it("is confirmed only by a second, different file, keeping the newest files", () => {
		const first = recordDemotion({ record: null, sig: "s", reason: "decode-stall", fileKey: "a", now: 1 })
		const again = recordDemotion({ record: first, sig: "s", reason: "decode-stall", fileKey: "a", now: 2 })
		const second = recordDemotion({ record: again, sig: "s", reason: "media-error", fileKey: "b", now: 3 })
		const third = recordDemotion({ record: second, sig: "s", reason: "media-error", fileKey: "c", now: 4 })

		expect(isConfirmedDemotion(first)).toBe(false)
		expect(isConfirmedDemotion(again)).toBe(false)
		expect(second).toEqual({ sig: "s", reason: "media-error", at: 3, files: ["a", "b"] })
		expect(isConfirmedDemotion(second)).toBe(true)
		expect(third.files).toEqual(["b", "c"])
	})

	it("drops rows written under another user agent", () => {
		expect(staleDemotionKeys([demotionKvKey(UA), `${DEMOTION_KV_PREFIX}Old Firefox/150.0`], UA)).toEqual([
			`${DEMOTION_KV_PREFIX}Old Firefox/150.0`
		])
	})
})

const ENV: PlaybackEnvironment = {
	browser: "firefox",
	mediaSource: "MediaSource",
	audioEncoder: true,
	videoDecoder: true,
	fullscreen: "element",
	wakeLock: true,
	pictureInPicture: false,
	audioTracks: false,
	frameCallback: true
}

function probeWith(overrides: Partial<CapabilityDeps> = {}) {
	const rows = new Map<string, LearnedDemotion[]>()
	let now = 50 * DAY
	const decodingInfo = vi.fn(() => Promise.resolve({ supported: true, smooth: true }))
	const isEncoderSupported = vi.fn((config: AudioEncoderConfig) => Promise.resolve(config.codec === "opus"))
	const deps: CapabilityDeps = {
		environment: () => ENV,
		userAgent: UA,
		canPlayType: () => "probably",
		isTypeSupported: () => true,
		decodingInfo,
		isEncoderSupported,
		kv: {
			get: key => Promise.resolve(rows.get(key) ?? null),
			set: (key, value) => {
				rows.set(key, value)

				return Promise.resolve()
			},
			keys: prefix => Promise.resolve([...rows.keys()].filter(key => key.startsWith(prefix))),
			delete: key => {
				rows.delete(key)

				return Promise.resolve()
			}
		},
		probeEncoders: () => Promise.resolve(NO_ENCODERS),
		encodeKv: {
			get: () => Promise.resolve(null),
			set: () => Promise.resolve(),
			keys: () => Promise.resolve([]),
			delete: () => Promise.resolve()
		},
		now: () => now,
		...overrides
	}

	return {
		deps,
		decodingInfo,
		isEncoderSupported,
		rows,
		probe: () => new PlaybackCapabilityProbe(deps),
		advance: (ms: number) => {
			now += ms
		}
	}
}

const LADDER_PROBE: LadderProbe = toLadderProbe(videoProbe())
const SELECTION: LadderSelection = { audioIndex: 1, subtitle: "none" }

describe("PlaybackCapabilityProbe", () => {
	it("answers the ladder's queries, asking decodingInfo once per configuration for the session", async () => {
		const { decodingInfo, isEncoderSupported, probe } = probeWith()
		const capabilities = probe()
		const first = await capabilities.capabilities(LADDER_PROBE, SELECTION, FACTS)
		const calls = decodingInfo.mock.calls.length

		expect(calls).toBeGreaterThan(0)
		expect(first.browser).toBe("firefox")
		expect(first.audioEncoders).toEqual(["opus"])
		expect(Object.values(first.canPlayType).every(answer => answer === "probably")).toBe(true)
		expect(Object.keys(first.decodingInfoMediaSource)).toContain('audio/mp4; codecs="ac-3"')

		// Another file with the same codecs costs no platform query.
		await capabilities.capabilities(LADDER_PROBE, SELECTION, { ...FACTS, bitrate: 2_000_000 })
		expect(decodingInfo.mock.calls.length).toBe(calls)
		expect(isEncoderSupported.mock.calls.length).toBe(2)
	})

	it("treats an unanswerable decodingInfo as no verdict, and skips MediaSource queries without MediaSource", async () => {
		const { probe } = probeWith({
			environment: () => ({ ...ENV, mediaSource: null }),
			decodingInfo: () => Promise.reject(new TypeError("unsupported field"))
		})
		const caps = await probe().capabilities(LADDER_PROBE, SELECTION, FACTS)

		expect(caps.mediaSource).toBe(false)
		expect(caps.decodingInfoFile).toEqual({})
		expect(caps.decodingInfoMediaSource).toEqual({})
		expect(caps.isTypeSupported).toEqual({})
	})

	it("persists browser verdicts only, and applies one only once two different files confirmed it, until the TTL", async () => {
		const harness = probeWith()

		await harness.probe().learn("direct|mp4|x|y", "no-first-frame", "file-1")
		await harness.probe().learn("remux|mkv|x|y", "network", "file-1")

		expect(harness.rows.get(demotionKvKey(UA))?.map(row => row.sig)).toEqual(["direct|mp4|x|y"])
		// One file can be broken itself.
		expect((await harness.probe().learned()).size).toBe(0)

		await harness.probe().learn("direct|mp4|x|y", "no-first-frame", "file-1")
		expect((await harness.probe().learned()).size).toBe(0)

		await harness.probe().learn("direct|mp4|x|y", "no-first-frame", "file-2")
		expect([...(await harness.probe().learned()).keys()]).toEqual(["direct|mp4|x|y"])

		harness.advance(DEMOTION_TTL_MS)

		expect((await harness.probe().learned()).size).toBe(0)
	})

	it("reads the stored record afresh per learn, keeping what another tab learned meanwhile", async () => {
		const harness = probeWith()
		const capabilities = harness.probe()

		await capabilities.learned()
		// Another tab, after this one loaded.
		harness.rows.set(demotionKvKey(UA), [{ sig: "other", reason: "silent-audio", at: 50 * DAY, files: ["x", "y"] }])
		await capabilities.learn("mine", "media-error", "file-1")

		expect(
			harness.rows
				.get(demotionKvKey(UA))
				?.map(row => row.sig)
				.sort()
		).toEqual(["mine", "other"])
		expect([...(await capabilities.learned()).keys()]).toEqual(["other"])
	})

	it("never writes after the stored record could not be read", async () => {
		const harness = probeWith()
		const set = vi.fn(() => Promise.resolve())

		harness.deps.kv.get = () => Promise.reject(new Error("locked"))
		harness.deps.kv.set = set

		const capabilities = harness.probe()

		await capabilities.learn("a", "media-error", "file-1")
		expect(set).not.toHaveBeenCalled()
	})

	it("drops what another browser build learned", async () => {
		const harness = probeWith()

		harness.rows.set(`${DEMOTION_KV_PREFIX}Firefox/150.0`, [
			{ sig: "direct|mp4|x|y", reason: "media-error", at: 50 * DAY, files: ["a", "b"] }
		])

		expect((await harness.probe().learned()).size).toBe(0)
		expect([...harness.rows.keys()]).toEqual([])
	})

	it("keeps working on defaults when storage fails", async () => {
		const harness = probeWith()

		harness.deps.kv.get = () => Promise.reject(new Error("no storage"))
		harness.deps.kv.set = () => Promise.reject(new Error("no storage"))

		const capabilities = harness.probe()

		expect((await capabilities.learned()).size).toBe(0)
		await expect(capabilities.learn("a", "media-error", "file-1")).resolves.toBeUndefined()
	})
})

const ENCODERS: EncodeCapabilities = {
	videoEncoder: true,
	audioEncoder: true,
	video: { avc: true, hevc: true, hevcMain10: true, vp9: true, av1: false },
	firstVideoCodec: "avc",
	audio: { aac: true, opus: true }
}

describe("PlaybackCapabilityProbe.encodeCapabilities", () => {
	function encodeHarness() {
		const encodeRows = new Map<string, EncodeCapabilities>()
		const probeEncoders = vi.fn(() => Promise.resolve(ENCODERS))
		const harness = probeWith({
			probeEncoders,
			encodeKv: {
				get: key => Promise.resolve(encodeRows.get(key) ?? null),
				set: (key, value) => {
					encodeRows.set(key, value)

					return Promise.resolve()
				},
				keys: prefix => Promise.resolve([...encodeRows.keys()].filter(key => key.startsWith(prefix))),
				delete: key => {
					encodeRows.delete(key)

					return Promise.resolve()
				}
			}
		})

		return { ...harness, encodeRows, probeEncoders }
	}

	it("probes nothing until an editor asks", () => {
		const { probe, probeEncoders } = encodeHarness()

		probe()

		expect(probeEncoders).not.toHaveBeenCalled()
	})

	it("probes once, stores the answer under this browser build and drops another build's", async () => {
		const harness = encodeHarness()

		harness.encodeRows.set(`${ENCODE_CAPS_KV_PREFIX}Firefox/150.0`, NO_ENCODERS)

		const capabilities = harness.probe()
		const [first, second] = await Promise.all([capabilities.encodeCapabilities(), capabilities.encodeCapabilities()])

		expect(first).toEqual(ENCODERS)
		expect(second).toBe(first)
		expect(harness.probeEncoders).toHaveBeenCalledTimes(1)
		expect([...harness.encodeRows]).toEqual([[encodeCapsKvKey(UA), ENCODERS]])
	})

	it("answers a later session from the stored row without probing", async () => {
		const harness = encodeHarness()

		harness.encodeRows.set(encodeCapsKvKey(UA), ENCODERS)

		expect(await harness.probe().encodeCapabilities()).toEqual(ENCODERS)
		expect(harness.probeEncoders).not.toHaveBeenCalled()
	})

	it("answers no encoders when the probe fails, stores nothing and asks again next time", async () => {
		const harness = encodeHarness()

		harness.probeEncoders.mockRejectedValueOnce(new Error("worker died"))

		const capabilities = harness.probe()

		expect(await capabilities.encodeCapabilities()).toEqual(NO_ENCODERS)
		expect(harness.encodeRows.size).toBe(0)
		expect(await capabilities.encodeCapabilities()).toEqual(ENCODERS)
		expect(harness.probeEncoders).toHaveBeenCalledTimes(2)
	})

	it("still probes when storage fails", async () => {
		const harness = encodeHarness()

		harness.deps.encodeKv.get = () => Promise.reject(new Error("no storage"))
		harness.deps.encodeKv.set = () => Promise.reject(new Error("no storage"))

		expect(await harness.probe().encodeCapabilities()).toEqual(ENCODERS)
	})

	it("validates a stored row against the schema", () => {
		expect(encodeCapabilitiesSchema(ENCODERS)).toEqual(ENCODERS)
		expect(encodeCapabilitiesSchema({ ...ENCODERS, firstVideoCodec: "mpeg2" })).toBeInstanceOf(type.errors)
	})
})
