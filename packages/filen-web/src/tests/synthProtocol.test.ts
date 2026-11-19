import { describe, expect, it } from "vitest"
import {
	SYNTH_SOURCE_ERROR,
	SYNTH_UNSUPPORTED_PREFIX,
	SynthSourceLost,
	SynthUnsupported,
	serveSynth,
	type SynthRequest,
	type SynthResponse,
	type SynthScope
} from "@/workers/synth/protocol"

// The synthesizer workers' shared message loop, behind a stand-in scope.

function served(answer: (request: SynthRequest) => Promise<Omit<SynthResponse, "id">>): {
	send: (request: SynthRequest & { id: number }) => Promise<void>
	posted: { message: unknown; transfer: Transferable[] | undefined }[]
	closed: () => boolean
} {
	let listener: ((event: MessageEvent<SynthRequest & { id: number }>) => void) | null = null
	let closed = false
	const posted: { message: unknown; transfer: Transferable[] | undefined }[] = []
	const scope: SynthScope = {
		addEventListener: (_type, added) => {
			listener = added
		},
		postMessage: (message, transfer) => {
			posted.push({ message, transfer })
		},
		close: () => {
			closed = true
		}
	}

	serveSynth(scope, answer)

	return {
		send: async request => {
			listener?.(new MessageEvent("message", { data: request }))

			await new Promise(resolve => {
				setTimeout(resolve, 0)
			})
		},
		posted,
		closed: () => closed
	}
}

describe("synthesizer message loop", () => {
	it("acknowledges a request, then answers it with its samples transferred", async () => {
		const data = new ArrayBuffer(8)
		const worker = served(() => Promise.resolve({ data, frames: 1 }))

		await worker.send({ id: 1, type: "render", handle: 1, frames: 1 })

		expect(worker.posted).toEqual([
			{ message: { id: 1, started: true }, transfer: undefined },
			{ message: { id: 1, data, frames: 1 }, transfer: [data] }
		])
		expect(worker.closed()).toBe(false)
	})

	it("answers an unsupported file and lost bytes as coded errors, and stays open", async () => {
		const worker = served(request =>
			Promise.reject(request.type === "probe" ? new SynthUnsupported("too large") : new SynthSourceLost("unloaded"))
		)

		await worker.send({ id: 1, type: "probe", head: new ArrayBuffer(0), size: 0 })
		await worker.send({ id: 2, type: "open", key: "a", sampleRate: 48_000 })

		expect(worker.posted.map(post => post.message)).toEqual([
			{ id: 1, started: true },
			{ id: 1, error: `${SYNTH_UNSUPPORTED_PREFIX}too large` },
			{ id: 2, started: true },
			{ id: 2, error: SYNTH_SOURCE_ERROR }
		])
		expect(worker.closed()).toBe(false)
	})

	it("answers anything else as fatal and closes", async () => {
		const worker = served(() => Promise.reject(new Error("unreachable")))

		await worker.send({ id: 3, type: "close", handle: 1 })

		expect(worker.posted.map(post => post.message)).toEqual([
			{ id: 3, started: true },
			{ id: 3, fatal: "unreachable" }
		])
		expect(worker.closed()).toBe(true)
	})
})
