import { beforeAll, describe, expect, it, vi } from "vitest"
import { exposeRangePort } from "@/lib/media/rangePort"
import { isAudioUnsupported, isSourceReadError } from "@/lib/media/remuxTypes"
import { SYNTH_SOURCE_ERROR, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"
import { tinyMod } from "@/tests/support/trackerModules"

// The module worker itself (the shipped libopenmpt build) run in this process behind a stand-in for its worker
// scope, and the remux worker's synthesizer input over it.

type Handler = (event: { data: SynthRequest & { id: number } }) => void

const scope: { handler: Handler | null; answer: (response: SynthResponse) => void; closed: boolean } = {
	handler: null,
	answer: () => undefined,
	closed: false
}
const loads: string[] = []

// What the remux worker starts as its nested worker: messages go to the worker module's listener and back.
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
		if (message.type === "load") {
			loads.push(message.key)
		}

		scope.handler?.({ data: message })
	}

	public terminate(): void {
		scope.closed = true
	}
}

vi.mock("@/workers/synth/module.worker.ts?worker", () => ({ default: InProcessWorker }))

// A module playback never starts the MIDI synthesizer, so it never evaluates spessasynth.
const midiWorkers = { started: 0 }

vi.mock("@/workers/synth/midi.worker.ts?worker", () => ({
	default: vi.fn(() => {
		midiWorkers.started++
	})
}))

beforeAll(async () => {
	Object.assign(globalThis, {
		self: {
			addEventListener: (_type: string, handler: Handler) => {
				scope.handler = handler
			},
			postMessage: (response: SynthResponse) => {
				queueMicrotask(() => {
					scope.answer(response)
				})
			},
			close: () => {
				scope.closed = true
			}
		}
	})
	await import("@/workers/synth/module.worker")
})

function serve(bytes: Uint8Array): { port: MessagePort; size: number; reads: () => number } {
	const { port1, port2 } = new MessageChannel()
	let reads = 0

	exposeRangePort(
		port1,
		(start, end) => {
			reads++

			return Promise.resolve(bytes.slice(start, end))
		},
		new AbortController()
	)

	return { port: port2, size: bytes.length, reads: () => reads }
}

describe("module synthesizer", () => {
	it("renders a module from the time asked, starting where the renderer landed", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(tinyMod())
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "a" })

		expect(input.info).toMatchObject({ codec: "module", sampleRate: 48_000, channels: 2 })
		expect(input.info.duration).toBeCloseTo(7.68, 3)

		const reader = input.reader({} as never, () => false)
		const first = await reader.first(3.3)

		// On the row boundary at or after 3.3 s.
		expect(first?.timestamp).toBeCloseTo(3.36, 3)
		expect(first?.sample.numberOfChannels).toBe(2)

		const second = first === null ? null : await reader.next(first)

		expect(second?.timestamp).toBeCloseTo((first?.timestamp ?? 0) + (first?.duration ?? 0), 6)

		await reader.close()
		await input.close()
		expect(midiWorkers.started).toBe(0)
	})

	it("reads a file once for every input of its key, and plays a 15-sample MOD the hint names", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const bytes = tinyMod(15)
		const player = serve(bytes)
		const analysis = serve(bytes)
		const before = loads.filter(key => key === "b").length
		const first = await synthAudioInput(player.port, player.size, "audio", { kind: "module", key: "b" })
		const second = await synthAudioInput(analysis.port, analysis.size, "analysis", { kind: "module", key: "b" })

		expect(loads.filter(key => key === "b").length - before).toBe(1)
		expect(analysis.reads()).toBe(0)
		expect(second.info.duration).toBeCloseTo(first.info.duration, 6)

		await first.close()
		await second.close()
	})

	it("refuses what libopenmpt does not read as unsupported audio, and a lost key as a read failure", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const garbage = serve(new Uint8Array(4096).fill(0x5a))

		await expect(synthAudioInput(garbage.port, garbage.size, "audio", { kind: "module", key: "c" })).rejects.toSatisfy(
			isAudioUnsupported
		)

		const { NestedWorker } = await import("@/workers/nestedWorker")
		const helper = new NestedWorker<SynthRequest, SynthResponse>(() => new InProcessWorker() as unknown as Worker, {
			name: "module synthesizer",
			toError: message =>
				message === SYNTH_SOURCE_ERROR ? Object.assign(new Error(message), { name: "SourceReadError" }) : new Error(message)
		})
		const worker = helper.acquire()

		await expect(helper.request(worker, { type: "open", key: "never loaded", sampleRate: 48_000 })).rejects.toSatisfy(isSourceReadError)
		helper.release()
	})
})
