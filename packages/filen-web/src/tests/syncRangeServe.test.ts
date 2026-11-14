import { describe, expect, it } from "vitest"
import { createSyncRangeBuffer } from "@filen/office/dom/pdfedit"
import { serveFileSyncRange } from "@/lib/media/syncRangeServe"

// The SDK worker's side of the PDF engine's byte bridge: its lifetime and the release of the client it reads with.
// The block protocol itself is tested in @filen/office.

const WAKE = "filen.syncRange.wake"
const CLOSE = "filen.syncRange.close"

function harness(options: { readonly withLock?: boolean; readonly slowRead?: boolean } = {}) {
	const { port1, port2 } = new MessageChannel()
	const buffer = createSyncRangeBuffer(8, 1024)
	const lifetime = new AbortController()
	const released: number[] = []
	const reads: number[] = []
	const gate = Promise.withResolvers<undefined>()
	const granted: (() => void)[] = []
	const locks = {
		request: (_name: string, callback: () => void) => {
			granted.push(callback)

			return Promise.resolve()
		}
	} as unknown as Pick<LockManager, "request">

	serveFileSyncRange(buffer, port2, {
		read: async (start, end) => {
			reads.push(start)

			if (options.slowRead === true) await gate.promise

			return new Uint8Array(end - start)
		},
		length: 8 * 1024,
		lifetime,
		readerLock: "reader",
		release: () => {
			released.push(reads.length)
		},
		...(options.withLock === true ? { locks } : {})
	})

	return { port1, buffer, lifetime, released, reads, gate, granted }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

function wake(buffer: SharedArrayBuffer, port: MessagePort, block: number): void {
	const ctrl = new Int32Array(buffer, 0, 10)

	Atomics.store(ctrl, 1, block)
	Atomics.store(ctrl, 2, 1)
	port.postMessage({ [WAKE]: Atomics.add(ctrl, 0, 1) + 1 })
}

describe("serveFileSyncRange", () => {
	it("stops and releases when the reader closes", async () => {
		const bridge = harness()

		wake(bridge.buffer, bridge.port1, 0)
		await tick()
		expect(bridge.reads).toEqual([0])
		bridge.port1.postMessage({ [CLOSE]: true })
		await tick()
		expect(bridge.lifetime.signal.aborted).toBe(true)
		expect(bridge.released).toEqual([1])
		bridge.port1.close()
	})

	it("releases only once the read running at shutdown settles", async () => {
		const bridge = harness({ slowRead: true })

		wake(bridge.buffer, bridge.port1, 2)
		await tick()
		bridge.lifetime.abort()
		await tick()
		expect(bridge.released).toEqual([])
		bridge.gate.resolve(undefined)
		await tick()
		expect(bridge.released).toEqual([1])
		bridge.port1.close()
	})

	it("stops when the page lets go of the reader lock", async () => {
		const bridge = harness({ withLock: true })

		expect(bridge.granted).toHaveLength(1)
		expect(bridge.lifetime.signal.aborted).toBe(false)
		bridge.granted[0]?.()
		expect(bridge.lifetime.signal.aborted).toBe(true)
		await tick()
		expect(bridge.released).toEqual([0])
		bridge.port1.close()
	})
})
