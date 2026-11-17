import { readFileSync } from "node:fs"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { exposeRangePort } from "@/lib/media/rangePort"
import { isAudioUnsupported, isSourceReadError } from "@/lib/media/remuxTypes"
import type { SynthRequest, SynthResponse } from "@/workers/synth/protocol"

// The MIDI worker itself (spessasynth with the bundled SoundFont) run in this process behind a stand-in for its worker
// scope, and the remux worker's synthesizer input over it.

type Handler = (event: { data: SynthRequest & { id: number } }) => void

const scope: { handler: Handler | null; answer: (response: SynthResponse) => void } = { handler: null, answer: () => undefined }
const SOUND_FONT = readFileSync(new URL("../assets/soundfonts/GeneralUser-GS-2.0.3.sf3", import.meta.url))
const fetches = { count: 0, fail: false }

class InProcessWorker {
	private readonly listeners: ((event: { data: SynthResponse }) => void)[] = []

	public constructor() {
		scope.answer = response => {
			for (const listener of this.listeners) {
				listener({ data: response })
			}
		}
	}

	public addEventListener(type: string, listener: (event: { data: SynthResponse }) => void): void {
		if (type === "message") {
			this.listeners.push(listener)
		}
	}

	public postMessage(message: SynthRequest & { id: number }): void {
		scope.handler?.({ data: message })
	}

	public terminate(): void {
		this.listeners.length = 0
	}
}

vi.mock("@/workers/synth/midi.worker.ts?worker", () => ({ default: InProcessWorker }))
vi.mock("@/workers/synth/module.worker.ts?worker", () => ({ default: InProcessWorker }))

beforeAll(async () => {
	Object.assign(globalThis, {
		self: {
			location: { href: "https://app.example/" },
			addEventListener: (_type: string, handler: Handler) => {
				scope.handler = handler
			},
			postMessage: (response: SynthResponse) => {
				queueMicrotask(() => {
					scope.answer(response)
				})
			},
			close: () => undefined
		}
	})
	await import("@/workers/synth/midi.worker")
})

beforeEach(() => {
	vi.stubGlobal("fetch", (url: string) => {
		fetches.count++

		return Promise.resolve(
			fetches.fail || !url.startsWith("https://app.example/") ? new Response(null, { status: 404 }) : new Response(SOUND_FONT)
		)
	})
})

function vlq(value: number): number[] {
	const out = [value & 0x7f]

	for (let rest = value >> 7; rest > 0; rest >>= 7) {
		out.unshift((rest & 0x7f) | 0x80)
	}

	return out
}

// One track of `notes` piano notes, an eighth apart at 120 BPM (480 ticks a quarter).
function song(notes: number): Uint8Array {
	const events = [0x00, 0xc0, 0x00]

	for (let i = 0; i < notes; i++) {
		events.push(...vlq(i === 0 ? 0 : 1), 0x90, 60 + (i % 12), 100, ...vlq(239), 0x80, 60 + (i % 12), 0)
	}

	events.push(0x00, 0xff, 0x2f, 0x00)

	const length = events.length

	return Uint8Array.from([
		0x4d,
		0x54,
		0x68,
		0x64,
		0,
		0,
		0,
		6,
		0,
		0,
		0,
		1,
		0x01,
		0xe0,
		0x4d,
		0x54,
		0x72,
		0x6b,
		length >>> 24,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
		...events
	])
}

function serve(bytes: Uint8Array): { port: MessagePort; size: number } {
	const { port1, port2 } = new MessageChannel()

	exposeRangePort(port1, (start, end) => Promise.resolve(bytes.slice(start, end)), new AbortController())

	return { port: port2, size: bytes.length }
}

function peak(data: ArrayBuffer | ArrayBufferView): number {
	const samples = new Float32Array(data instanceof ArrayBuffer ? data : data.buffer)

	return samples.reduce((most, value) => Math.max(most, Math.abs(value)), 0)
}

describe("MIDI synthesizer without its bank", () => {
	it("knows a song's length without its bank, and fails the read, for Retry, when the SoundFont cannot be fetched", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(song(2))

		fetches.fail = true
		fetches.count = 0

		try {
			const input = await synthAudioInput(source.port, source.size, "audio", { kind: "midi", key: "c" })

			expect(input.info.duration).toBeCloseTo(0.5 + 2, 1)
			expect(fetches.count).toBe(0)

			const reader = input.reader({} as never, () => false)

			await expect(reader.first(0)).rejects.toSatisfy(isSourceReadError)
			await reader.close()
			await input.close()
		} finally {
			fetches.fail = false
		}
	})
})

describe("MIDI synthesizer", () => {
	it("plays a song with its release, from where it was asked, fetching the bundled bank once for every song", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const bytes = song(8)

		fetches.count = 0
		const first = serve(bytes)
		const input = await synthAudioInput(first.port, first.size, "audio", { kind: "midi", key: "a" })

		// Eight eighths at 120 BPM, then the two seconds of release.
		expect(input.info).toMatchObject({ codec: "midi", sampleRate: 48_000, channels: 2 })
		expect(input.info.duration).toBeCloseTo(2 + 2, 1)

		const reader = input.reader({} as never, () => false)
		const start = await reader.first(0)

		expect(start?.timestamp).toBe(0)

		// The first half second: the samples decode as the notes first sound.
		let loudest = 0

		for (let item = start; item !== null && item.timestamp < 0.5; item = await reader.next(item)) {
			const samples = new Float32Array(item.sample.numberOfFrames)

			item.sample.copyTo(samples, { planeIndex: 0, format: "f32-planar" })
			loudest = Math.max(loudest, peak(samples))
		}

		expect(loudest).toBeGreaterThan(0.001)

		// Inside the release tail: only the release plays, up to the end.
		const tail = await reader.first(3)

		expect(tail?.timestamp).toBe(3)

		await reader.close()

		const second = serve(song(4))
		const other = await synthAudioInput(second.port, second.size, "audio", { kind: "midi", key: "b" })
		const otherReader = other.reader({} as never, () => false)

		await otherReader.first(0)
		expect(fetches.count).toBe(1)

		await otherReader.close()
		await other.close()
		await input.close()
	})

	it("refuses a song past the event cap before parsing it, and what is not MIDI", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const dense = serve(song(130_000))

		await expect(synthAudioInput(dense.port, dense.size, "audio", { kind: "midi", key: "dense" })).rejects.toSatisfy(isAudioUnsupported)

		const garbage = serve(new Uint8Array(2048).fill(7))

		await expect(synthAudioInput(garbage.port, garbage.size, "audio", { kind: "midi", key: "garbage" })).rejects.toSatisfy(
			isAudioUnsupported
		)
	})

	it("refuses a song whose header divides a beat into no ticks, which would never end", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const bytes = song(4)

		bytes[12] = 0
		bytes[13] = 0

		const endless = serve(bytes)

		await expect(synthAudioInput(endless.port, endless.size, "audio", { kind: "midi", key: "endless" })).rejects.toSatisfy(
			isAudioUnsupported
		)
	})

	it("renders nothing past the song's end and its release", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(song(4))
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "midi", key: "past" })
		const reader = input.reader({} as never, () => false)

		expect(await reader.first(input.info.duration + 1)).toBeNull()
		await reader.close()
		await input.close()
	})
})
