import { describe, expect, it } from "vitest"
import {
	CTRL,
	RESP,
	SYNC_RANGE_WAKE,
	SyncRangeLayout,
	createSyncRangeBuffer,
	serveSyncRange,
	type SyncRangePort
} from "../../dom/pdfedit/syncRange"

// The server side of the sync range bridge, driven the way a reader drives it (request words, then a wake message)
// without blocking this thread.

const BLOCK = 1024

function fakePort(): SyncRangePort & { send(data: unknown): void; closed: boolean } {
	const listeners: ((event: { readonly data: unknown }) => void)[] = []
	const port = {
		closed: false,
		postMessage: () => undefined,
		addEventListener: (_type: "message", listener: (event: { readonly data: unknown }) => void) => {
			listeners.push(listener)
		},
		close: () => {
			port.closed = true
		},
		send: (data: unknown) => {
			for (const listener of listeners) listener({ data })
		}
	}

	return port
}

function setup(length: number, slots = 16, readAhead = 3) {
	const buffer = createSyncRangeBuffer(slots, BLOCK)
	const layout = new SyncRangeLayout(buffer)
	const port = fakePort()
	const lifetime = new AbortController()
	const bytes = Uint8Array.from({ length }, (_, index) => (index * 7 + 3) & 0xff)
	const reads: number[] = []
	const stats = serveSyncRange(
		buffer,
		port,
		{
			length,
			read: async (start, end) => {
				reads.push(start / BLOCK)

				return bytes.slice(start, end)
			}
		},
		{ lifetime: lifetime.signal, readAhead }
	)
	const request = async (block: number, count: number): Promise<number> => {
		Atomics.store(layout.ctrl, CTRL.reqBlock, block)
		Atomics.store(layout.ctrl, CTRL.reqCount, count)

		const seq = Atomics.add(layout.ctrl, CTRL.reqSeq, 1) + 1

		port.send({ [SYNC_RANGE_WAKE]: seq })

		for (let spin = 0; spin < 1000 && Atomics.load(layout.ctrl, CTRL.respSeq) !== seq; spin++)
			await new Promise(resolve => setTimeout(resolve, 1))

		return Atomics.load(layout.ctrl, CTRL.respStatus)
	}
	const holds = (block: number): boolean => {
		const slot = layout.find(block, -1)

		if (slot === -1) return false

		const start = slot * BLOCK
		const expected = bytes.subarray(block * BLOCK, Math.min(length, (block + 1) * BLOCK))

		return layout.data.subarray(start, start + expected.length).every((byte, index) => byte === expected[index])
	}

	return { request, holds, reads, stats, lifetime, port }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe("serveSyncRange", () => {
	it("writes the requested blocks and reads ahead only after a sequential request", async () => {
		const server = setup(BLOCK * 40 + 100)

		expect(await server.request(10, 1)).toBe(RESP.ok)
		await settle()
		expect(server.holds(10)).toBe(true)
		// A first request is not a pattern yet.
		expect(server.reads).toEqual([10])

		expect(await server.request(11, 1)).toBe(RESP.ok)
		await settle()
		expect(server.reads).toEqual([10, 11, 12])
		expect([12, 13, 14].every(block => server.holds(block))).toBe(true)

		// Already resident: answered without a read.
		expect(await server.request(13, 2)).toBe(RESP.ok)
		await settle()
		expect(server.reads.slice(3)).toEqual([15])
	})

	it("serves the last, partial block exactly", async () => {
		const server = setup(BLOCK * 3 + 100)

		expect(await server.request(3, 1)).toBe(RESP.ok)
		expect(server.holds(3)).toBe(true)
		expect(server.stats.bytesRead).toBe(100)
	})

	it("reuses the least recently used slot when the ring is full", async () => {
		const server = setup(BLOCK * 64, 4, 0)

		for (const block of [0, 5, 10, 15, 20, 25]) expect(await server.request(block, 1)).toBe(RESP.ok)

		expect([10, 15, 20, 25].every(block => server.holds(block))).toBe(true)
		expect(server.holds(0)).toBe(false)
	})

	it("refuses a request outside the file and answers every request closed after shutdown", async () => {
		const server = setup(BLOCK * 4)

		expect(await server.request(9, 1)).toBe(RESP.failed)
		server.lifetime.abort()
		expect(server.port.closed).toBe(true)
		expect(await server.request(0, 1)).toBe(RESP.closed)
	})
})
