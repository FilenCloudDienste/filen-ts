import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { AudioSample, EncodedPacket, type CustomAudioDecoder } from "mediabunny"
import { describe, expect, it, vi } from "vitest"
import manifest from "@/vendor/ffmpeg-decoders/manifest.json"
import WORKER_SOURCE from "@/vendor/ffmpeg-decoders/decoders.worker.js?raw"
import {
	DecoderWorker,
	decodedChannelMask,
	ffmpegAudioDecoder,
	ffmpegDecodedCodecs,
	type DecodedFrame,
	type DecoderRequest
} from "@/workers/remux/ffmpegDecoder"

type Posted = DecoderRequest & { id: number }

// Stands in for the nested worker: records what is posted and answers when told to.
class FakeWorker {
	public readonly posted: { message: Posted; transfer: Transferable[] }[] = []
	public terminated = false
	private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

	public addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
	}

	public postMessage(message: Posted, transfer: Transferable[]): void {
		this.posted.push({ message, transfer })
	}

	public terminate(): void {
		this.terminated = true
	}

	public answer(response: Record<string, unknown>): void {
		for (const listener of this.listeners.get("message") ?? []) {
			listener({ data: response })
		}
	}

	public crash(message: string): void {
		for (const listener of this.listeners.get("error") ?? []) {
			listener({ message, preventDefault: () => undefined })
		}
	}

	public last(): Posted {
		const entry = this.posted.at(-1)

		if (entry === undefined) {
			throw new Error("nothing posted")
		}

		return entry.message
	}
}

function harness() {
	const workers: FakeWorker[] = []
	const client = new DecoderWorker(() => {
		const worker = new FakeWorker()

		workers.push(worker)

		return worker as unknown as Worker
	})
	const Decoder = ffmpegAudioDecoder(client, ffmpegDecodedCodecs("webkit"))
	const samples: AudioSample[] = []
	const errors: Error[] = []
	// Mediabunny's own wiring: it constructs the registered class and assigns these before init().
	const makeDecoder = (codec = "ac3"): CustomAudioDecoder =>
		Object.assign(new (Decoder as unknown as new () => CustomAudioDecoder)(), {
			codec,
			config: { codec, sampleRate: 48_000, numberOfChannels: 6 },
			onSample: (sample: AudioSample) => samples.push(sample),
			onError: (error: unknown) => {
				errors.push(error instanceof Error ? error : new Error(String(error)))
			}
		})
	const decoder = makeDecoder()

	const worker = (): FakeWorker => {
		const current = workers.at(-1)

		if (current === undefined) {
			throw new Error("no worker started")
		}

		return current
	}

	return { workers, worker, decoder, makeDecoder, samples, errors }
}

async function opened(h: ReturnType<typeof harness>, handle = 7, decoder = h.decoder): Promise<void> {
	const init = decoder.init()

	h.worker().answer({ id: h.worker().last().id, handle })
	await init
}

function packet(timestamp = 0): EncodedPacket {
	return new EncodedPacket(new Uint8Array(4), "key", timestamp, 0.032)
}

function frame(overrides: Partial<DecodedFrame> = {}): DecodedFrame {
	return {
		data: new Float32Array(2 * 1536).buffer,
		format: "f32-planar",
		channels: 2,
		channelMask: 0b11,
		sampleRate: 48_000,
		frames: 1536,
		timestampUs: 1_000_000,
		...overrides
	}
}

describe("FfmpegAudioDecoder", () => {
	it("takes AC-3, E-AC-3 and DTS everywhere, FLAC only in WebKit, and leaves every other codec to the browser", () => {
		const supported = (engine: "chromium" | "firefox" | "webkit") =>
			["ac3", "eac3", "dts", "flac", "aac", "opus", "mp3", "vorbis"].filter(codec =>
				ffmpegAudioDecoder(new DecoderWorker(() => new FakeWorker() as unknown as Worker), ffmpegDecodedCodecs(engine)).supports(
					codec as "aac",
					{ codec, sampleRate: 48_000, numberOfChannels: 2 }
				)
			)

		expect(supported("chromium")).toEqual(["ac3", "eac3", "dts"])
		expect(supported("firefox")).toEqual(["ac3", "eac3", "dts"])
		expect(supported("webkit")).toEqual(["ac3", "eac3", "dts", "flac"])
	})

	it("opens a decoder for the track's codec in one shared worker", async () => {
		const h = harness()

		await opened(h)

		expect(h.workers).toHaveLength(1)
		expect(h.worker().last()).toMatchObject({ type: "open", codec: "ac3" })
	})

	it("hands the decoder the track's configuration, FLAC's STREAMINFO among it", async () => {
		const h = harness()
		const description = Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34])
		const decoder = Object.assign(h.makeDecoder("flac"), {
			config: { codec: "flac", sampleRate: 44_100, numberOfChannels: 2, description }
		})

		await opened(h, 7, decoder)

		const { message, transfer } = h.worker().posted.at(-1) ?? { message: null, transfer: [] }

		expect(message).toMatchObject({ type: "open", codec: "flac" })
		expect(message?.type === "open" && message.extradata !== undefined ? new Uint8Array(message.extradata) : null).toEqual(description)
		expect(transfer).toHaveLength(1)
		// The demuxer keeps its own copy.
		expect(description.byteLength).toBe(8)
	})

	it("opens with no configuration for an empty one", async () => {
		const h = harness()
		const decoder = Object.assign(h.makeDecoder("ac3"), {
			config: { codec: "ac3", sampleRate: 48_000, numberOfChannels: 6, description: new Uint8Array(0) }
		})

		await opened(h, 7, decoder)

		const { message, transfer } = h.worker().posted.at(-1) ?? { message: null, transfer: [] }

		expect(message).toMatchObject({ type: "open", codec: "ac3" })
		expect(message).not.toHaveProperty("extradata")
		expect(transfer).toHaveLength(0)
	})

	it("sends a transferred copy of each packet with its microsecond timestamp, and emits what comes back", async () => {
		const h = harness()

		await opened(h)

		const bytes = new Uint8Array([0x0b, 0x77, 1, 2, 3])
		const decoding = h.decoder.decode(new EncodedPacket(bytes, "key", 1.5, 0.032))
		const { message, transfer } = h.worker().posted.at(-1) ?? { message: null, transfer: [] }

		expect(message).toMatchObject({ type: "decode", handle: 7, timestampUs: 1_500_000 })
		expect(transfer).toHaveLength(1)
		expect(message?.type === "decode" ? new Uint8Array(message.data) : null).toEqual(bytes)
		// The packet's own bytes stay with the demuxer.
		expect(bytes.byteLength).toBe(5)

		h.worker().answer({ id: h.worker().last().id, frames: [frame({ timestampUs: 1_500_000, channelMask: 0x60f, channels: 6 })] })
		await decoding

		expect(h.samples).toHaveLength(1)
		expect(h.samples[0]).toMatchObject({ format: "f32-planar", numberOfChannels: 6, sampleRate: 48_000, timestamp: 1.5 })
		// The downmix places the planes by the mask FFmpeg named them with.
		expect(h.samples[0] === undefined ? null : decodedChannelMask(h.samples[0])).toBe(0x60f)
	})

	it("records no mask for a sample FFmpeg could not name the speakers of", async () => {
		const h = harness()

		await opened(h)

		const decoding = h.decoder.decode(packet())

		h.worker().answer({ id: h.worker().last().id, frames: [frame({ channelMask: -1 })] })
		await decoding

		expect(h.samples[0] === undefined ? undefined : decodedChannelMask(h.samples[0])).toBeNull()
	})

	it("emits nothing for a packet FFmpeg skipped as damaged", async () => {
		const h = harness()

		await opened(h)

		const decoding = h.decoder.decode(packet())

		h.worker().answer({ id: h.worker().last().id, frames: [] })
		await decoding

		expect(h.samples).toEqual([])
		expect(h.errors).toEqual([])
	})

	it("places a sample FFmpeg gave no timestamp right after the previous one", async () => {
		const h = harness()

		await opened(h)

		const decoding = h.decoder.decode(packet(2))

		h.worker().answer({ id: h.worker().last().id, frames: [frame({ timestampUs: 2_000_000 }), frame({ timestampUs: Number.NaN })] })
		await decoding

		expect(h.samples.map(sample => sample.timestamp)).toEqual([2, 2.032])
	})

	it("reports a failed call through onError and resolves, so the calls chained after it still run", async () => {
		const h = harness()

		await opened(h)

		const decoding = h.decoder.decode(packet())

		h.worker().answer({ id: h.worker().last().id, error: "FFmpeg decoding failed (-12)" })

		await expect(decoding).resolves.toBeUndefined()
		expect(h.errors.map(error => error.message)).toEqual(["FFmpeg decoding failed (-12)"])
	})

	it("closes and stops the worker after a failure, the way mediabunny chains its calls", async () => {
		// Mediabunny's CallSerializer: each call runs after the previous one settled successfully.
		const h = harness()
		let chain = Promise.resolve()
		const call = (fn: () => unknown) => (chain = chain.then(fn).then(() => undefined))

		void call(() => h.decoder.init())
		await vi.waitFor(() => {
			expect(h.workers).toHaveLength(1)
		})
		h.worker().answer({ id: h.worker().last().id, handle: 7 })
		void call(() => h.decoder.decode(packet()))
		await vi.waitFor(() => {
			expect(h.worker().last()).toMatchObject({ type: "decode" })
		})
		h.worker().answer({ id: h.worker().last().id, error: "out of memory for an FFmpeg packet" })
		void call(() => h.decoder.flush())
		await vi.waitFor(() => {
			expect(h.worker().last()).toMatchObject({ type: "flush" })
		})
		h.worker().crash("worker died")
		await call(() => h.decoder.close())

		expect(h.errors.map(error => error.message)).toEqual(["out of memory for an FFmpeg packet", "worker died"])
		expect(h.worker().terminated).toBe(true)
	})

	it("balances a failed open with its close, so the worker still stops", async () => {
		const h = harness()
		const init = h.decoder.init()

		h.worker().answer({ id: h.worker().last().id, error: "no FFmpeg decoder for aac" })
		await init
		await h.decoder.close()

		expect(h.errors.map(error => error.message)).toEqual(["no FFmpeg decoder for aac"])
		expect(h.worker().terminated).toBe(true)
	})

	it("drains on flush", async () => {
		const h = harness()

		await opened(h)

		const flushing = h.decoder.flush()

		expect(h.worker().last()).toMatchObject({ type: "flush", handle: 7 })
		h.worker().answer({ id: h.worker().last().id, frames: [frame()] })
		await flushing

		expect(h.samples).toHaveLength(1)
	})

	it("closes a decoder in the shared worker, and terminates the worker with the last one", async () => {
		const h = harness()
		const second = h.makeDecoder("dts")

		await opened(h)
		await opened(h, 8, second)

		expect(h.workers).toHaveLength(1)
		expect(h.worker().last()).toMatchObject({ type: "open", codec: "dts" })

		await h.decoder.close()

		expect(h.worker().last()).toMatchObject({ type: "close", handle: 7 })
		expect(h.worker().terminated).toBe(false)

		await h.decoder.decode(packet())

		expect(h.errors.map(error => error.message)).toEqual([expect.stringContaining("closed")])

		await second.close()

		expect(h.worker().terminated).toBe(true)

		// The next decoder starts a fresh worker.
		await opened(h, 9)

		expect(h.workers).toHaveLength(2)
	})

	it("fails everything waiting on a crashed worker and every decoder in it, and starts a fresh one for the next", async () => {
		const h = harness()
		const survivor = h.makeDecoder()

		await opened(h)
		await opened(h, 8, survivor)

		const decoding = h.decoder.decode(packet())

		h.worker().crash("refused by the content security policy")
		await decoding

		expect(h.workers[0]?.terminated).toBe(true)
		// Its handle meant something only in the worker that crashed.
		await survivor.decode(packet())

		expect(h.errors.map(error => error.message)).toEqual([
			"refused by the content security policy",
			"the audio decoder worker was lost"
		])

		await opened(h, 9, h.makeDecoder())

		expect(h.workers).toHaveLength(2)
		expect(h.worker().last()).toMatchObject({ type: "open" })
	})

	it("drops a worker whose module trapped, with every decoder in it", async () => {
		const h = harness()
		const other = h.makeDecoder("dts")

		await opened(h)
		await opened(h, 8, other)

		const decoding = h.decoder.decode(packet())

		h.worker().answer({ id: h.worker().last().id, fatal: "RuntimeError: memory access out of bounds" })
		await decoding
		await other.decode(packet())

		expect(h.workers[0]?.terminated).toBe(true)
		expect(h.errors.map(error => error.message)).toEqual([
			"RuntimeError: memory access out of bounds",
			"the audio decoder worker was lost"
		])

		await opened(h, 9, h.makeDecoder())

		expect(h.workers).toHaveLength(2)
	})
})

describe("vendored FFmpeg decoders module", () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url))
	const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
	const file = read("../vendor/ffmpeg-decoders/decoders.worker.js")

	it("is the exact build its manifest records", () => {
		expect(file.byteLength).toBe(manifest.output["decoders.worker.js"].bytes)
		expect(sha256(file)).toBe(manifest.output["decoders.worker.js"].sha256)
		expect(WORKER_SOURCE).toBe(file.toString("utf8"))
	})

	it("was built from the sources in the repository, which are its corresponding source", () => {
		// An edit to the build script, the bridge or the worker loop without a rebuild fails here: the shipped
		// module would no longer match the source the notice points to.
		expect(sha256(read("../../scripts/codecs/build-ffmpeg-decoders.sh"))).toBe(manifest.sources["build-ffmpeg-decoders.sh"])
		expect(sha256(read("../../scripts/codecs/bridge.c"))).toBe(manifest.sources["bridge.c"])

		const loop = read("../../scripts/codecs/decoder-worker.js")

		expect(sha256(loop)).toBe(manifest.sources["decoder-worker.js"])
		expect(WORKER_SOURCE.endsWith(loop.toString("utf8"))).toBe(true)
	})

	it("ships the licenses of what Emscripten links in, as recorded at build time", () => {
		expect(sha256(read("../vendor/ffmpeg-decoders/licenses/emscripten-LICENSE"))).toBe(
			manifest.emscripten.licenses["emscripten-LICENSE"]
		)
		expect(sha256(read("../vendor/ffmpeg-decoders/licenses/musl-COPYRIGHT"))).toBe(manifest.emscripten.licenses["musl-COPYRIGHT"])
	})

	it("needs nothing the app's content security policy forbids", () => {
		// script-src allows 'wasm-unsafe-eval' but no 'unsafe-eval', and the worker runs from a Blob.
		expect(WORKER_SOURCE.match(/\beval\(|new Function\(|importScripts\(/g)).toBeNull()
		// Plain ASCII, so no bundler re-escapes the inlined module.
		expect(Buffer.byteLength(WORKER_SOURCE, "utf8")).toBe(WORKER_SOURCE.length)
	})

	it("is built from a licence-compatible FFmpeg configuration", () => {
		expect(manifest.ffmpeg.configure).not.toContain("--enable-gpl")
		expect(manifest.ffmpeg.configure).not.toContain("--enable-nonfree")
		expect(manifest.ffmpeg.configure).toContain(
			"--enable-decoder=ac3,eac3,dca,truehd,mlp,alac,flac,wmav1,wmav2,wmapro,wmalossless,mp1,mp2,amrnb,amrwb,adpcm_ms,adpcm_ima_wav"
		)
	})
})
