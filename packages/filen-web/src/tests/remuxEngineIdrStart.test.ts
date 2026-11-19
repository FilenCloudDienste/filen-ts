import { describe, expect, it, vi } from "vitest"
import { EncodedPacket } from "mediabunny"
import type { RemuxEvent } from "@/lib/media/remuxTypes"
import { PumpGate } from "@/workers/remux/pump"

// Where video starts only at IDR pictures (Firefox with HEVC), the walk back to one is one read per key
// packet: a seek's canStartAt and the start that follows at the same time walk it once between them.

// One length-prefixed NAL unit of `type`: 19 is an IDR picture, 21 a CRA.
const nal = (type: number): Uint8Array => new Uint8Array([0, 0, 0, 2, type << 1, 1])
// An IDR at 0, CRA keys every 2 s after it.
const KEYS: EncodedPacket[] = [0, 2, 4, 6, 8].map(timestamp => new EncodedPacket(nal(timestamp === 0 ? 19 : 21), "key", timestamp, 0.04))
// What follows a packet: delta packets of 400 bytes, 25 a second, never another key packet, for 2 s.
const DELTA = new Uint8Array(400)

const reads = vi.hoisted(() => ({ keyPackets: 0 }))

vi.mock("mediabunny", async importOriginal => ({
	...(await importOriginal<typeof import("mediabunny")>()),
	EncodedPacketSink: class {
		public getKeyPacket(timestamp: number): Promise<EncodedPacket | null> {
			reads.keyPackets++

			return Promise.resolve(KEYS.findLast(key => key.timestamp <= timestamp) ?? null)
		}

		public getFirstKeyPacket(): Promise<EncodedPacket | null> {
			return Promise.resolve(KEYS[0] ?? null)
		}

		public getNextPacket(packet: EncodedPacket): Promise<EncodedPacket | null> {
			const timestamp = packet.timestamp + 0.04

			return Promise.resolve(timestamp < 2 ? new EncodedPacket(DELTA, "delta", timestamp, 0.04) : null)
		}
	}
}))

vi.mock("@/lib/media/rangePort", () => ({
	rangePortReader: () => ({ readRange: vi.fn(), onLost: vi.fn(), close: vi.fn() })
}))

const { RemuxEngine } = await import("@/workers/remux/engine")
const { FragmentedTrackOutput, FragmentTooLargeError } = await import("@/workers/remux/output")
const { EncodedPacketSink } = await import("mediabunny")

interface EngineInternals {
	video: {
		track: unknown
		idrOnly: { lengthSize: number | null } | null
		codec?: "vp9"
		config?: VideoDecoderConfig
		rotation?: 0
		reorderFrames?: null
	}
	duration: number
	startKey(sink: unknown, at: number, video: EngineInternals["video"], gate: PumpGate): Promise<EncodedPacket | null>
}

const VP9: VideoDecoderConfig = { codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 64 }

describe("RemuxEngine IDR starts", () => {
	it("walks back to the IDR once for a canStartAt and the start at the same time", async () => {
		const engine = new RemuxEngine(
			{
				port: new MessageChannel().port1,
				size: 1000,
				transcodeTargets: [],
				maxFragmentBytes: { video: 1_000_000, audio: 1_000_000 },
				idrOnlyStart: true
			},
			() => undefined
		)
		const internals = engine as unknown as EngineInternals

		internals.video = { track: {}, idrOnly: { lengthSize: 4 } }
		internals.duration = 100

		expect(await engine.canStartAt(9)).toBe(true)

		const walk = reads.keyPackets

		expect(walk).toBe(5)

		const start = await internals.startKey(new EncodedPacketSink({} as never), 9, internals.video, new PumpGate(0))

		expect(start?.timestamp).toBe(0)
		expect(reads.keyPackets - walk).toBe(1)

		// Another time walks again.
		const other = await internals.startKey(new EncodedPacketSink({} as never), 7, internals.video, new PumpGate(0))

		expect(other?.timestamp).toBe(0)
		expect(reads.keyPackets - walk - 1).toBe(4)
	})
})

// Key packets further apart than the cap allows: the worker refuses the fragment rather than buffer all of it.
describe("fragment size cap", () => {
	it("rejects a fragment that outgrows the cap before its next key packet", async () => {
		const output = new FragmentedTrackOutput({
			track: { kind: "video", codec: "vp9", decoderConfig: VP9, rotation: 0, reorderFrames: null },
			gate: new PumpGate(Number.POSITIVE_INFINITY),
			maxFragmentBytes: 1000,
			onSegment: () => undefined
		})
		const [key] = KEYS

		if (key === undefined) {
			throw new Error("no key packet")
		}

		await output.write(key)
		await output.write(new EncodedPacket(DELTA, "delta", 0.04, 0.04))
		await output.write(new EncodedPacket(DELTA, "delta", 0.08, 0.04))
		await expect(output.write(new EncodedPacket(DELTA, "delta", 0.12, 0.04))).rejects.toBeInstanceOf(FragmentTooLargeError)
		await output.cancel()
	})

	it("ends the run with one fragmentTooLarge error and no segment after it", async () => {
		const events: RemuxEvent[] = []
		const finished = Promise.withResolvers<undefined>()
		const engine = new RemuxEngine(
			{
				port: new MessageChannel().port1,
				size: 1000,
				transcodeTargets: [],
				maxFragmentBytes: { video: 1000, audio: 1_000_000 }
			},
			event => {
				events.push(event)

				if (event.type === "error" || event.type === "ended") {
					finished.resolve(undefined)
				}
			}
		)
		const internals = engine as unknown as EngineInternals

		internals.video = { track: {}, idrOnly: null, codec: "vp9", config: VP9, rotation: 0, reorderFrames: null }
		internals.duration = 100

		await engine.seek({ generation: 1, time: 0, horizon: Number.POSITIVE_INFINITY, video: true, audio: null })
		await finished.promise
		// Segments are handed on in microtasks; let any a cancelled muxer still produces arrive.
		await new Promise(resolve => setTimeout(resolve, 10))

		const errors = events.filter(event => event.type === "error")
		const errorAt = events.findIndex(event => event.type === "error")

		expect(errors).toEqual([expect.objectContaining({ kind: "video", generation: 1, fragmentTooLarge: true, sourceLost: false })])
		expect(events.slice(errorAt + 1)).toEqual([])
	})
})
