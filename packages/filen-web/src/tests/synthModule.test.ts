import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { exposeRangePort } from "@/lib/media/rangePort"
import { isAudioUnsupported, isSourceReadError } from "@/lib/media/remuxTypes"
import { SYNTH_SOURCE_ERROR, type SynthRequest, type SynthResponse } from "@/workers/synth/protocol"
import { largeXm, mmcmpPacked, tinyMod } from "@/tests/support/trackerModules"

// The module worker itself (the shipped libopenmpt build) run in this process behind a stand-in for its worker
// scope, and the remux worker's synthesizer input over it.

type Handler = (event: { data: SynthRequest & { id: number } }) => void

const scope: { handler: Handler | null; answer: (response: SynthResponse) => void; closed: boolean } = {
	handler: null,
	answer: () => undefined,
	closed: false
}
const loads: string[] = []
// Every request the worker was sent, by type.
const posted: SynthRequest[] = []

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
		posted.push(message)

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

// The heap's allocations as the module worker makes them, failing while `full` is set: what a capped heap that has no
// room answers.
const heap: {
	full: boolean
	reported: number | null
	trap: boolean
	lib: Awaited<ReturnType<typeof import("@/vendor/libopenmpt/libopenmpt.js").default>> | null
} = { full: false, reported: null, trap: false, lib: null }

vi.mock("@/vendor/libopenmpt/libopenmpt.js", async importOriginal => {
	const actual = await importOriginal<typeof import("@/vendor/libopenmpt/libopenmpt.js")>()

	return {
		default: async (options: Parameters<typeof actual.default>[0]) => {
			const lib = await actual.default(options)

			heap.lib = lib
			const malloc = lib._malloc.bind(lib)

			const heapBytes = lib._filen_heap_bytes.bind(lib)

			lib._malloc = size => (heap.full ? 0 : malloc(size))
			lib._filen_heap_bytes = () => heap.reported ?? heapBytes()

			const render = lib._filen_render.bind(lib)

			// A trap in the module, as WebAssembly raises one.
			lib._filen_render = (...args) => {
				if (heap.trap) {
					throw new WebAssembly.RuntimeError("unreachable")
				}

				return render(...args)
			}

			return lib
		}
	}
})

// The shipped wasm, read from disk where the remux worker fetches it.
vi.mock("@/workers/synth/libopenmptWasm", () => ({
	compileLibopenmpt: () => WebAssembly.compile(readFileSync(new URL("../vendor/libopenmpt/libopenmpt.wasm", import.meta.url)))
}))

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

// `bytes` served by range, claiming `size` bytes (their own length unless a test says the file is larger).
function serve(bytes: Uint8Array, size = bytes.length): { port: MessagePort; size: number; reads: () => number; bytesRead: () => number } {
	const { port1, port2 } = new MessageChannel()
	let reads = 0
	let bytesRead = 0

	exposeRangePort(
		port1,
		(start, end) => {
			reads++
			bytesRead += end - start

			const range = new Uint8Array(end - start)

			range.set(bytes.subarray(start, Math.min(end, bytes.length)))

			return Promise.resolve(range)
		},
		new AbortController()
	)

	return { port: port2, size, reads: () => reads, bytesRead: () => bytesRead }
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
		first?.sample.close()
		second?.sample.close()

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

	it("answers a module's length at load, building no renderer for it", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(tinyMod())
		const from = posted.length
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "length" })

		expect(input.info.duration).toBeCloseTo(7.68, 3)
		expect(posted.slice(from).map(request => request.type)).not.toContain("open")
		await input.close()
	})

	it("closes a renderer whose reader closed while it was still opening", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(tinyMod())
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "early" })
		const reader = input.reader({} as never, () => false)
		const from = posted.length
		const first = reader.first(0)

		await reader.close()
		const landed = await first.catch(() => null)

		landed?.sample.close()
		await vi.waitFor(() => {
			const opened = posted.slice(from).filter(request => request.type === "open").length
			const closed = posted.slice(from).filter(request => request.type === "close").length

			expect(opened).toBe(1)
			expect(closed).toBe(1)
		})
		await input.close()
	})

	it("refuses a file the heap has no room for, and a render it cannot buffer, without losing the instance", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")

		heap.full = true

		try {
			const refused = serve(tinyMod())

			await expect(synthAudioInput(refused.port, refused.size, "audio", { kind: "module", key: "full" })).rejects.toSatisfy(
				isAudioUnsupported
			)
		} finally {
			heap.full = false
		}

		const source = serve(tinyMod())
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "room" })
		const starved = input.reader({} as never, () => false)

		heap.full = true

		try {
			await expect(starved.first(0)).rejects.toSatisfy(isAudioUnsupported)
		} finally {
			heap.full = false
		}

		await starved.close()

		const reader = input.reader({} as never, () => false)
		const first = await reader.first(0)

		expect(first?.sample.numberOfFrames).toBe(4096)
		first?.sample.close()
		expect(scope.closed).toBe(false)
		await reader.close()
		await input.close()
	})

	it("keeps libopenmpt's log off the console", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const spies = (["log", "warn", "error", "info", "debug"] as const).map(level => vi.spyOn(console, level))

		try {
			const garbage = serve(new Uint8Array(4096).fill(0x33))

			await expect(synthAudioInput(garbage.port, garbage.size, "audio", { kind: "module", key: "quiet" })).rejects.toSatisfy(
				isAudioUnsupported
			)

			for (const spy of spies) {
				expect(spy).not.toHaveBeenCalled()
			}
		} finally {
			for (const spy of spies) {
				spy.mockRestore()
			}
		}
	})

	it("hands a read's buffer over whole rather than copying it, and copies only a view into a larger one", async () => {
		const { standalone } = await import("@/workers/remux/synthAudioInput")
		const whole = new Uint8Array(64)
		const view = new Uint8Array(new ArrayBuffer(128), 16, 64)

		expect(standalone(whole)).toBe(whole.buffer)
		expect(standalone(view)).not.toBe(view.buffer)
		expect(standalone(view).byteLength).toBe(64)
	})

	it("replaces an instance whose heap grew far once nothing renders on it, keeping it for the inputs it has", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const bytes = tinyMod()
		const grown = serve(bytes)
		const input = await synthAudioInput(grown.port, grown.size, "audio", { kind: "module", key: "grown" })
		const reader = input.reader({} as never, () => false)

		const start = await reader.first(0)

		start?.sample.close()
		heap.reported = 200 * 1024 * 1024

		try {
			await reader.close()
			await vi.waitFor(() => {
				expect(posted.at(-1)?.type).toBe("close")
			})
			await new Promise(resolve => setTimeout(resolve, 10))
		} finally {
			heap.reported = null
		}

		// The old instance still serves the input it has.
		const again = input.reader({} as never, () => false)

		const replay = await again.first(0)

		expect(replay?.timestamp).toBe(0)
		replay?.sample.close()
		await again.close()

		const before = loads.filter(key => key === "grown").length
		const fresh = serve(bytes)
		const next = await synthAudioInput(fresh.port, fresh.size, "audio", { kind: "module", key: "grown" })

		// A fresh instance: the key is loaded into it anew.
		expect(loads.filter(key => key === "grown").length - before).toBe(1)
		await next.close()
		await input.close()
	})

	it("reads a camcorder's MPEG program stream named .mod no further than its head, and a file past the cap not at all", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const { SYNTH_HEAD_BYTES } = await import("@/lib/media/remuxTypes")
		const pack = new Uint8Array(64 * 1024)

		pack.set([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x89, 0xc3, 0xf8])

		// Told it is 3 GB, past the module cap: nothing of it is read.
		const camcorder = serve(pack, 3 * 1024 * 1024 * 1024)

		await expect(synthAudioInput(camcorder.port, camcorder.size, "audio", { kind: "module", key: "camcorder" })).rejects.toSatisfy(
			isAudioUnsupported
		)
		expect(camcorder.bytesRead()).toBe(0)

		const small = serve(pack)
		const loadsBefore = loads.length

		await expect(synthAudioInput(small.port, small.size, "audio", { kind: "module", key: "small-ps" })).rejects.toSatisfy(
			isAudioUnsupported
		)
		expect(small.bytesRead()).toBe(SYNTH_HEAD_BYTES)
		expect(loads.length).toBe(loadsBefore)

		const huge = serve(tinyMod(), 32 * 1024 * 1024 + 1)

		await expect(synthAudioInput(huge.port, huge.size, "audio", { kind: "module", key: "huge" })).rejects.toSatisfy(isAudioUnsupported)
		expect(huge.reads()).toBe(0)
	})

	it("probes a head as a module, or not", async () => {
		const { synthFor } = await import("@/workers/remux/synthAudioInput")
		const mod = tinyMod()

		await expect(synthFor("module").reads(mod.subarray(0, 2048), mod.length)).resolves.toBe(true)
		await expect(synthFor("module").reads(new Uint8Array(2048).fill(0x20), 1_000_000)).resolves.toBe(false)
	})

	it("renders the same bytes through two interleaved cursors of one stream as through fresh streams", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const { PcmStream } = await import("@/workers/remux/pcmStream")
		const { emptyRemuxStats } = await import("@/lib/media/remuxTypes")
		const bytes = tinyMod(31, true)
		const open = async (key: string) => {
			const source = serve(bytes)

			return PcmStream.open(await synthAudioInput(source.port, source.size, "audio", { kind: "module", key }), emptyRemuxStats())
		}
		const signal = new AbortController().signal
		const stream = await open("cursors")
		const { WAV_HEADER_BYTES } = await import("@/workers/remux/wav.logic")
		const dataOffset = WAV_HEADER_BYTES
		// Two places, each read in two steps: a cursor at 1 s, one at 5 s, taking turns.
		const second = 48_000 * stream.layout.blockAlign
		const at = (seconds: number, step: number): [number, number] => [
			dataOffset + seconds * second + step * 16_384,
			dataOffset + seconds * second + (step + 1) * 16_384
		]
		const interleaved = [
			await stream.read(...at(1, 0), signal),
			await stream.read(...at(5, 0), signal),
			await stream.read(...at(1, 1), signal),
			await stream.read(...at(5, 1), signal)
		]
		const early = await open("cursors-early")
		const late = await open("cursors-late")
		const fresh = [
			await early.read(...at(1, 0), signal),
			await late.read(...at(5, 0), signal),
			await early.read(...at(1, 1), signal),
			await late.read(...at(5, 1), signal)
		]

		expect(interleaved.map(part => [...part])).toEqual(fresh.map(part => [...part]))
		expect(interleaved.every(part => part.some(byte => byte !== 0))).toBe(true)

		for (const each of [stream, early, late]) {
			await each.close()
		}
	})

	it("drops an instance a module trapped in, failing its reader as a read, and plays the next open on a fresh one", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const source = serve(tinyMod())
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "trap" })
		const reader = input.reader({} as never, () => false)

		heap.trap = true

		try {
			await expect(reader.first(0)).rejects.toSatisfy(isSourceReadError)
		} finally {
			heap.trap = false
		}

		expect(scope.closed).toBe(true)
		await reader.close()
		await input.close()
		scope.closed = false

		const again = serve(tinyMod())
		const next = await synthAudioInput(again.port, again.size, "audio", { kind: "module", key: "trap" })
		const played = next.reader({} as never, () => false)
		const first = await played.first(0)

		expect(first?.sample.numberOfFrames).toBe(4096)
		first?.sample.close()
		await played.close()
		await next.close()
	})

	it("plays libopenmpt's own MPTM test module, and a module packed with MMCMP", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		// test/test.mptm of the libopenmpt release this build pins (BSD-3-Clause, as libopenmpt).
		const mptm = serve(new Uint8Array(readFileSync(new URL("fixtures/synth/test.mptm", import.meta.url))))
		const own = await synthAudioInput(mptm.port, mptm.size, "audio", { kind: "module", key: "mptm" })

		expect(own.info.duration).toBeGreaterThan(0)

		const reader = own.reader({} as never, () => false)
		const first = await reader.first(0)

		expect(first?.sample.numberOfFrames).toBe(4096)
		first?.sample.close()
		await reader.close()
		await own.close()

		const packed = serve(mmcmpPacked(tinyMod()))
		const unpacked = await synthAudioInput(packed.port, packed.size, "audio", { kind: "module", key: "mmcmp" })

		expect(unpacked.info.duration).toBeCloseTo(7.68, 3)
		await unpacked.close()
	})

	it("keeps a module at the 32 MiB cap within libopenmpt's 256 MiB heap", async () => {
		const { synthAudioInput } = await import("@/workers/remux/synthAudioInput")
		const bytes = largeXm(32 * 1024 * 1024 - 1024)
		const source = serve(bytes)
		const input = await synthAudioInput(source.port, source.size, "audio", { kind: "module", key: "at-cap" })
		const reader = input.reader({} as never, () => false)
		const first = await reader.first(0)

		expect(first?.sample.numberOfFrames).toBe(4096)
		first?.sample.close()
		expect(heap.lib?._filen_heap_bytes()).toBeLessThanOrEqual(256 * 1024 * 1024)
		await reader.close()
		await input.close()
	}, 60_000)

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
