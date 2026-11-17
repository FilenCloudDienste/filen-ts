import { readFileSync } from "node:fs"
import { runInThisContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BufferSource, EncodedPacketSink, Input } from "mediabunny"
import { mpegAudioHeader, parseAsfHeader } from "@filen/shared/videos"
import WORKER_SOURCE from "@/vendor/ffmpeg-decoders/decoders.worker.js?raw"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { FLV } from "@/lib/media/demux/flvDemuxer"
import { MPEG_PS } from "@/lib/media/demux/mpegPsDemuxer"
import { waveProbedCodec, type ProbedCodec } from "@/workers/remux/audioInput"
import type { DecodedFrame } from "@/workers/remux/ffmpegDecoder"

// The shipped module itself, run in Node behind a stand-in for its worker scope: the bridge and the worker
// loop exercised on real AC-3, E-AC-3 and DTS frames (synthetic tones, three 1536-sample AC-3 frames, three
// E-AC-3, two 512-sample DTS, all 5.1), and on ffmpeg-encoded tones of the codecs that need the container's format
// fields: half a second of mono 22.05 kHz WMA 2 in ASF, Microsoft and IMA ADPCM in WAVE, and a quarter second of
// stereo 48 kHz MP2. Flash ADPCM in FLV is ffmpeg's (`-c:a adpcm_swf`, half a second of a 440 Hz tone at 22.05 kHz).
// ffmpeg writes DVD LPCM of 16 bits only, so the 24-bit one is a quarter second of 440/660 Hz stereo at 48 kHz grouped
// as libavcodec/pcm-dvd.c reads it, in packs and PES of private stream 1; ffmpeg decodes it back to its source.

interface Answer {
	id: number
	handle?: number
	frames?: DecodedFrame[]
	error?: string
	fatal?: string
}

const AC3_FRAME = 768
const EAC3_FRAME = 384
const DTS_FRAME = 1024
// AV_CH_LAYOUT_5POINT1: FL FR FC LFE SL SR.
const MASK_5_1 = 0x60f

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(`./fixtures/ffmpeg-decoders/${name}`, import.meta.url)))
}

function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("missing")
	}

	return value
}

function frames(bytes: Uint8Array, size: number): Uint8Array[] {
	return Array.from({ length: bytes.length / size }, (_, index) => bytes.slice(index * size, (index + 1) * size))
}

function startWorker() {
	const answers = new Map<number, (answer: Answer) => void>()
	let listener: ((event: { data: unknown }) => void) | null = null
	let nextId = 0
	const scope = {
		location: { href: "file:///decoders.worker.js" },
		closed: false,
		addEventListener: (_type: string, handler: (event: { data: unknown }) => void) => {
			listener = handler
		},
		postMessage: (answer: Answer) => {
			answers.get(answer.id)?.(answer)
		},
		close: () => {
			scope.closed = true
		}
	}
	const evaluate = runInThisContext(`(function (self, setInterval) {\n${WORKER_SOURCE}\n})`) as (
		self: unknown,
		setInterval: () => void
	) => void

	// The worker's keepalive timer would hold the test process open.
	evaluate(scope, () => undefined)

	const request = (message: Record<string, unknown>): Promise<Answer> => {
		const id = nextId++

		return new Promise(resolve => {
			answers.set(id, resolve)
			listener?.({ data: { id, ...message } })
		})
	}
	const decode = async (handle: number | undefined, bytes: Uint8Array, timestampUs = 0): Promise<Answer> =>
		request({ type: "decode", handle, data: bytes.slice().buffer, timestampUs })

	return { scope, request, decode }
}

let logged: unknown[][] = []

beforeEach(() => {
	logged = []

	for (const method of ["log", "warn", "error"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args)
		})
	}
})

afterEach(() => {
	// FFmpeg's log stays quiet, damaged input included.
	expect(logged).toEqual([])
})

describe("FFmpeg decoders module", () => {
	it.each([
		["ac3", "ac3-51.ac3", AC3_FRAME, 1536],
		["eac3", "eac3-51.eac3", EAC3_FRAME, 1536],
		["dts", "dts-51.dts", DTS_FRAME, 512]
	] as const)("decodes %s 5.1 to planar float with its channel mask and timestamps", async (codec, file, size, perFrame) => {
		const worker = startWorker()
		const { handle } = await worker.request({ type: "open", codec })
		const packets = frames(fixture(file), size)

		for (const [index, packet] of packets.entries()) {
			// Whole microseconds travel through FFmpeg unchanged.
			const timestampUs = Math.round((index * perFrame * 1_000_000) / 48_000)
			const answer = await worker.decode(handle, packet, timestampUs)

			expect(answer.error).toBeUndefined()
			expect(answer.frames?.map(frame => ({ ...frame, data: frame.data.byteLength }))).toEqual([
				{
					data: perFrame * 6 * 4,
					format: "f32-planar",
					channels: 6,
					channelMask: MASK_5_1,
					sampleRate: 48_000,
					frames: perFrame,
					timestampUs
				}
			])
		}

		expect(await worker.request({ type: "flush", handle })).toMatchObject({ frames: [] })
		expect(await worker.request({ type: "close", handle })).toEqual({ id: packets.length + 2 })
	})

	it("skips packets the decoders reject, whatever the error, and decodes on", async () => {
		const worker = startWorker()
		const ac3 = (await worker.request({ type: "open", codec: "ac3" })).handle
		const [first, second] = frames(fixture("ac3-51.ac3"), AC3_FRAME)

		if (first === undefined || second === undefined) {
			throw new Error("fixture too short")
		}

		// No syncword at all, and a header with an impossible bitstream id (AC-3's own parse error code, which
		// once ended the whole audio track).
		const badBsid = first.slice()

		badBsid[5] = 0xf8

		for (const damaged of [new Uint8Array(AC3_FRAME), badBsid, first.slice(0, 40)]) {
			expect(await worker.decode(ac3, damaged)).toEqual({ id: expect.any(Number) as number, frames: [] })
		}

		expect((await worker.decode(ac3, second)).frames).toHaveLength(1)

		const eac3 = (await worker.request({ type: "open", codec: "eac3" })).handle
		const dts = (await worker.request({ type: "open", codec: "dts" })).handle
		const [eac3Frame] = frames(fixture("eac3-51.eac3"), EAC3_FRAME)
		const [dtsFrame] = frames(fixture("dts-51.dts"), DTS_FRAME)

		expect((await worker.decode(eac3, eac3Frame?.slice(0, 100) ?? new Uint8Array())).frames).toEqual([])
		expect((await worker.decode(eac3, eac3Frame ?? new Uint8Array())).frames).toHaveLength(1)
		expect((await worker.decode(dts, new Uint8Array(DTS_FRAME).fill(0x55))).frames).toEqual([])
		expect((await worker.decode(dts, dtsFrame ?? new Uint8Array())).frames).toHaveLength(1)
	})

	// The decoded frames' sample count and their loudest sample, which a tone (ffmpeg's sine, at 1/8 of full scale)
	// puts well above silence.
	async function decodeAll(
		probed: ProbedCodec,
		packets: Uint8Array[]
	): Promise<{ frames: DecodedFrame[]; samples: number; peak: number }> {
		const worker = startWorker()
		const { handle, error } = await worker.request({
			type: "open",
			codec: probed.codec,
			...(probed.extradata === undefined ? {} : { extradata: probed.extradata.slice().buffer }),
			...(probed.stream === undefined ? {} : { stream: probed.stream })
		})

		expect(error).toBeUndefined()

		const decoded: DecodedFrame[] = []

		for (const [index, packet] of packets.entries()) {
			decoded.push(...((await worker.decode(handle, packet, index * 1000)).frames ?? []))
		}

		decoded.push(...((await worker.request({ type: "flush", handle })).frames ?? []))

		let peak = 0

		for (const frame of decoded) {
			// The first plane: float samples, or 16-bit ones for the fixed-point decoders.
			const plane = frame.format.startsWith("f32")
				? Array.from(new Float32Array(frame.data, 0, frame.frames), Math.abs)
				: Array.from(new Int16Array(frame.data, 0, frame.frames), value => Math.abs(value) / 32768)

			peak = Math.max(peak, ...plane)
		}

		return { frames: decoded, samples: decoded.reduce((sum, frame) => sum + frame.frames, 0), peak }
	}

	// A WAVE file's fmt chunk and its data cut into blocks of `blockAlign` bytes.
	function wave(bytes: Uint8Array): { format: Uint8Array; blocks: Uint8Array[] } {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let format: Uint8Array = new Uint8Array()
		let data: Uint8Array = new Uint8Array()

		for (let at = 12; at + 8 <= bytes.length; at += 8 + view.getUint32(at + 4, true) + (view.getUint32(at + 4, true) & 1)) {
			const id = String.fromCharCode(...bytes.subarray(at, at + 4))
			const body = bytes.subarray(at + 8, at + 8 + view.getUint32(at + 4, true))

			if (id === "fmt ") {
				format = body
			} else if (id === "data") {
				data = body
			}
		}

		const blockAlign = new DataView(format.buffer, format.byteOffset, format.byteLength).getUint16(12, true)

		return { format, blocks: frames(data.subarray(0, data.length - (data.length % blockAlign)), blockAlign) }
	}

	it.each([
		["adpcm-ms-mono.wav", "adpcm_ms"],
		["adpcm-ima-mono.wav", "adpcm_ima_wav"]
	] as const)("decodes %s with the block size and bits per sample its format states", async (file, codec) => {
		const { format, blocks } = wave(fixture(file))
		const probed = waveProbedCodec("adpcm", format, null, null)

		expect(probed?.codec).toBe(codec)

		const result = await decodeAll(defined(probed), blocks)

		expect(result.frames.every(frame => frame.sampleRate === 22_050 && frame.channels === 1)).toBe(true)
		expect(Math.abs(result.samples - 11_025)).toBeLessThan(2048)
		expect(result.peak).toBeGreaterThan(0.05)
	})

	it("decodes WMA 2 from its ASF stream's format: block size, bit rate and extra data", async () => {
		const bytes = fixture("wmav2-mono.asf")
		const stream = parseAsfHeader(bytes).streams.find(entry => "audio" in entry)
		const probed = stream === undefined ? null : waveProbedCodec("wma", stream.specific, 22_050, 1)
		const input = new Input({ formats: [ASF], source: new BufferSource(bytes) })
		const track = await input.getPrimaryAudioTrack()
		const packets: Uint8Array[] = []

		for await (const packet of new EncodedPacketSink(defined(track)).packets()) {
			packets.push(packet.data)
		}

		expect(probed).toMatchObject({ codec: "wmav2", stream: { bitRate: 32_000, sampleRate: 22_050, channels: 1 } })
		expect(probed?.stream?.blockAlign).toBeGreaterThan(0)

		const result = await decodeAll(defined(probed), packets)

		expect(result.frames.every(frame => frame.sampleRate === 22_050 && frame.channels === 1)).toBe(true)
		expect(Math.abs(result.samples - 11_025)).toBeLessThan(4096)
		expect(result.peak).toBeGreaterThan(0.05)
	})

	it("decodes MP2 frame by frame", async () => {
		const bytes = fixture("mp2-stereo.mp2")
		const packets: Uint8Array[] = []

		for (let at = 0; at + 4 <= bytes.length;) {
			const header = mpegAudioHeader(bytes, at)
			const size = header?.frameBytes ?? null

			if (size === null) {
				break
			}

			packets.push(bytes.slice(at, at + size))
			at += size
		}

		const result = await decodeAll({ codec: "mp2" }, packets)

		expect(packets.length).toBeGreaterThan(5)
		expect(result.frames.every(frame => frame.sampleRate === 48_000 && frame.channels === 2)).toBe(true)
		expect(result.samples).toBe(packets.length * 1152)
		expect(result.peak).toBeGreaterThan(0.05)
	})

	async function packetsOf(input: Input): Promise<Uint8Array[]> {
		const packets: Uint8Array[] = []

		for await (const packet of new EncodedPacketSink(defined(await input.getPrimaryAudioTrack())).packets()) {
			packets.push(packet.data)
		}

		return packets
	}

	it("decodes 24-bit DVD LPCM from a program stream, sample groups and all", async () => {
		const input = new Input({ formats: [MPEG_PS], source: new BufferSource(fixture("lpcm24-stereo.vob")) })
		const probed = defined(waveProbedCodec("lpcm", null, 48_000, 2))
		const result = await decodeAll(probed, await packetsOf(input))
		const samples = result.frames.flatMap(frame => Array.from(new Int32Array(frame.data, 0, frame.frames * frame.channels)))

		expect(probed.codec).toBe("pcm_dvd")
		expect(result.frames.every(frame => frame.format === "s32" && frame.sampleRate === 48_000 && frame.channels === 2)).toBe(true)
		expect(samples.length).toBeGreaterThan(11_000 * 2)

		// Both channels' tones, to 24 bits (the low byte of a 32-bit sample is 0).
		for (let i = 0; i < samples.length / 2; i += 97) {
			const t = i / 48_000

			expect(Math.abs((samples[i * 2] ?? 0) / 2 ** 31 - 0.5 * Math.sin(2 * Math.PI * 440 * t))).toBeLessThan(1e-5)
			expect(Math.abs((samples[i * 2 + 1] ?? 0) / 2 ** 31 - 0.5 * Math.sin(2 * Math.PI * 660 * t))).toBeLessThan(1e-5)
			expect((samples[i * 2] ?? 0) & 0xff).toBe(0)
		}
	})

	it("decodes Flash ADPCM from an FLV", async () => {
		const input = new Input({ formats: [FLV], source: new BufferSource(fixture("adpcm-swf-mono.flv")) })
		const probed = defined(waveProbedCodec("adpcmswf", null, 22_050, 1))
		const result = await decodeAll(probed, await packetsOf(input))

		expect(probed.codec).toBe("adpcm_swf")
		expect(result.frames.every(frame => frame.sampleRate === 22_050 && frame.channels === 1)).toBe(true)
		expect(Math.abs(result.samples - 11_025)).toBeLessThan(4096)
		expect(result.peak).toBeGreaterThan(0.4)
	})

	it("opens the decoders no fixture here encodes, given their format fields", async () => {
		const worker = startWorker()

		for (const [codec, stream] of [
			["mp1", undefined],
			["amrnb", { blockAlign: 0, bitRate: 0, sampleRate: 8000, channels: 1, bitsPerSample: 0 }],
			["amrwb", { blockAlign: 0, bitRate: 0, sampleRate: 16_000, channels: 1, bitsPerSample: 0 }]
		] as const) {
			const answer = await worker.request({ type: "open", codec, ...(stream === undefined ? {} : { stream }) })

			expect(answer.error, codec).toBeUndefined()
			expect(answer.handle, codec).toEqual(expect.any(Number))
		}
	})

	it("refuses an unknown codec without opening a decoder", async () => {
		const worker = startWorker()

		expect(await worker.request({ type: "open", codec: "aac" })).toEqual({ id: 0, error: "no FFmpeg decoder for aac" })
		expect(await worker.request({ type: "open", codec: "constructor" })).toEqual({ id: 1, error: "no FFmpeg decoder for constructor" })
		expect(worker.scope.closed).toBe(false)
	})

	it("answers a trap in the module as fatal and closes the worker, ignoring what comes after", async () => {
		const worker = startWorker()

		await worker.request({ type: "open", codec: "ac3" })

		const answer = await worker.decode(0x7ffffff0, new Uint8Array(AC3_FRAME))

		expect(answer.fatal).toEqual(expect.any(String))
		expect(answer.error).toBeUndefined()
		expect(worker.scope.closed).toBe(true)

		const late = await Promise.race([
			worker.request({ type: "open", codec: "ac3" }),
			new Promise(resolve => {
				setTimeout(() => {
					resolve("unanswered")
				}, 50)
			})
		])

		expect(late).toBe("unanswered")
	})
})
