import { describe, expect, it } from "vitest"
import { BlockAbortError, BlockCache, type AbortableReadRange } from "@/lib/media/blockCache"
import { BLOCK_BYTES } from "@filen/shared/videos"

// A file whose byte at position p is p % 251, so any slice can be checked without storing the file.
const PERIOD = 251

function expected(start: number, end: number): Uint8Array {
	const out = new Uint8Array(end - start)
	const phase = start % PERIOD

	for (let index = 0; index < Math.min(out.length, PERIOD); index++) {
		out[index] = (phase + index) % PERIOD
	}

	// Doubling copies of the first period: fast for the multi-megabyte ranges below.
	for (let filled = PERIOD; filled < out.length; filled *= 2) {
		out.copyWithin(filled, 0, Math.min(filled, out.length - filled))
	}

	return out
}

// Byte equality without a deep-equal walk, which is far too slow for megabytes.
function same(actual: Uint8Array, wanted: Uint8Array): boolean {
	return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(wanted)
}

interface Harness {
	cache: BlockCache
	requests: [number, number][]
	// Settles every request made so far.
	flush: () => Promise<void>
	aborted: [number, number][]
}

function harness(params: { blocks: number; capacity?: number; readAhead?: number; manual?: boolean }): Harness {
	const size = params.blocks * BLOCK_BYTES - 100
	const requests: [number, number][] = []
	const aborted: [number, number][] = []
	const pending: (() => void)[] = []
	const readRange: AbortableReadRange = (start, end, signal) => {
		requests.push([start, end])

		return new Promise((resolve, reject) => {
			let settled = false
			const settle = () => {
				if (!settled) {
					settled = true
					resolve(expected(start, end))
				}
			}

			signal.addEventListener("abort", () => {
				if (!settled) {
					settled = true
					aborted.push([start, end])
					reject(new DOMException("aborted", "AbortError"))
				}
			})

			if (params.manual === true) {
				pending.push(settle)
			} else {
				queueMicrotask(settle)
			}
		})
	}

	return {
		cache: new BlockCache(size, readRange, {
			...(params.capacity === undefined ? {} : { capacity: params.capacity }),
			...(params.readAhead === undefined ? {} : { readAhead: params.readAhead })
		}),
		requests,
		aborted,
		flush: async () => {
			for (const settle of pending.splice(0)) {
				settle()
			}

			await new Promise(resolve => setTimeout(resolve, 0))
		}
	}
}

describe("BlockCache", () => {
	it("returns the requested bytes across block boundaries", async () => {
		const { cache } = harness({ blocks: 4 })
		const start = BLOCK_BYTES - 10
		const end = 2 * BLOCK_BYTES + 10

		expect(same(await cache.read(start, end), expected(start, end))).toBe(true)
	})

	it("serves a resident block synchronously, as a view", async () => {
		const { cache, requests } = harness({ blocks: 2 })

		await cache.read(0, 10)

		const again = cache.read(100, 200)

		expect(again).toBeInstanceOf(Uint8Array)
		expect(again).toEqual(expected(100, 200))
		expect(requests).toHaveLength(1)
	})

	it("peeks at resident blocks only, without downloading, read-ahead or a change to the eviction order", async () => {
		const { cache, requests } = harness({ blocks: 6, capacity: 2, readAhead: 2 })

		expect(cache.peek(0, 10)).toBeNull()
		expect(requests).toHaveLength(0)

		await cache.read(0, 10)
		await cache.read(BLOCK_BYTES, BLOCK_BYTES + 10)

		expect(cache.peek(5, 50)).toEqual(expected(5, 50))
		expect(same(cache.peek(BLOCK_BYTES - 7, BLOCK_BYTES + 7) ?? new Uint8Array(), expected(BLOCK_BYTES - 7, BLOCK_BYTES + 7))).toBe(
			true
		)
		expect(cache.peek(BLOCK_BYTES - 7, 2 * BLOCK_BYTES + 7)).toBeNull()

		// Peeking at block 0 did not make it the most recent: the next block evicts it.
		cache.peek(0, 10)
		await new Promise(resolve => setTimeout(resolve, 0))

		const before = requests.length

		await cache.read(3 * BLOCK_BYTES, 3 * BLOCK_BYTES + 10)

		expect(cache.isResident(0)).toBe(false)
		expect(cache.isResident(BLOCK_BYTES)).toBe(true)
		expect(requests.length).toBe(before + 1)
	})

	it("downloads a block once however many readers want it at the same time", async () => {
		const { cache, requests, flush } = harness({ blocks: 2, manual: true })
		const reads = [cache.read(0, 10), cache.read(20, 30), cache.read(BLOCK_BYTES - 5, BLOCK_BYTES)]

		await flush()

		expect(await Promise.all(reads.map(read => Promise.resolve(read)))).toEqual([
			expected(0, 10),
			expected(20, 30),
			expected(BLOCK_BYTES - 5, BLOCK_BYTES)
		])
		expect(requests).toEqual([[0, BLOCK_BYTES]])
	})

	it("fetches contiguous missing blocks as one range request", async () => {
		const { cache, requests } = harness({ blocks: 8, readAhead: 0 })

		await cache.read(0, 3 * BLOCK_BYTES)

		expect(requests).toEqual([[0, 3 * BLOCK_BYTES]])
		expect(cache.stats.blockReads).toBe(3)
	})

	it("evicts the least recently used block past its capacity", async () => {
		const { cache, requests } = harness({ blocks: 8, capacity: 2, readAhead: 0 })

		await cache.read(0, 1)
		await cache.read(4 * BLOCK_BYTES, 4 * BLOCK_BYTES + 1)
		// Touch block 0 so block 4 is the oldest.
		await cache.read(0, 1)
		await cache.read(6 * BLOCK_BYTES, 6 * BLOCK_BYTES + 1)

		expect(cache.isResident(0)).toBe(true)
		expect(cache.isResident(4 * BLOCK_BYTES)).toBe(false)
		expect(cache.isResident(6 * BLOCK_BYTES)).toBe(true)
		expect(requests).toHaveLength(3)
	})

	it("reads ahead once the reader has moved forward block by block twice", async () => {
		const { cache, requests } = harness({ blocks: 10, readAhead: 3 })

		await cache.read(0, 10)
		await cache.read(BLOCK_BYTES, BLOCK_BYTES + 10)

		expect(cache.stats.readAheadBlocks).toBe(0)

		await cache.read(2 * BLOCK_BYTES, 2 * BLOCK_BYTES + 10)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(cache.stats.readAheadBlocks).toBe(3)
		expect(requests.at(-1)).toEqual([3 * BLOCK_BYTES, 6 * BLOCK_BYTES])
		expect(cache.read(4 * BLOCK_BYTES, 4 * BLOCK_BYTES + 1)).toBeInstanceOf(Uint8Array)
	})

	it("does not read ahead for a reader that jumps around", async () => {
		const { cache } = harness({ blocks: 10, readAhead: 3 })

		await cache.read(0, 10)
		await cache.read(7 * BLOCK_BYTES, 7 * BLOCK_BYTES + 10)
		await cache.read(3 * BLOCK_BYTES, 3 * BLOCK_BYTES + 10)
		await cache.read(9 * BLOCK_BYTES, 9 * BLOCK_BYTES + 10)

		expect(cache.stats.readAheadBlocks).toBe(0)
	})

	it("aborts downloads in flight, rejecting their readers, and keeps resident blocks", async () => {
		const { cache, flush, aborted } = harness({ blocks: 4, manual: true })
		const first = cache.read(0, 10)

		await flush()
		await first

		const pending = cache.read(2 * BLOCK_BYTES, 2 * BLOCK_BYTES + 10)

		cache.abort()

		await expect(pending).rejects.toBeInstanceOf(BlockAbortError)
		expect(aborted).toEqual([[2 * BLOCK_BYTES, 3 * BLOCK_BYTES]])
		expect(cache.isResident(0)).toBe(true)
		expect(cache.isResident(2 * BLOCK_BYTES)).toBe(false)
	})

	it("downloads a block again after an aborted attempt", async () => {
		const { cache, flush, requests } = harness({ blocks: 4, manual: true })
		const pending = cache.read(BLOCK_BYTES, BLOCK_BYTES + 10)

		cache.abort()
		await expect(pending).rejects.toBeInstanceOf(BlockAbortError)

		const retried = cache.read(BLOCK_BYTES, BLOCK_BYTES + 10)

		await flush()

		expect(await retried).toEqual(expected(BLOCK_BYTES, BLOCK_BYTES + 10))
		expect(requests).toHaveLength(2)
	})

	it("streams a large range block by block, each piece a view", async () => {
		const { cache } = harness({ blocks: 12, capacity: 2, readAhead: 0 })
		const start = 100
		const end = 9 * BLOCK_BYTES + 100
		const reader = cache.stream(start, end).getReader()
		const pieces: Uint8Array[] = []

		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			pieces.push(next.value)
		}

		const joined = new Uint8Array(end - start)
		let offset = 0

		for (const piece of pieces) {
			joined.set(piece, offset)
			offset += piece.length
		}

		expect(pieces).toHaveLength(10)
		expect(same(joined, expected(start, end))).toBe(true)
	})

	it("rejects reads outside the file", () => {
		const { cache } = harness({ blocks: 1 })

		expect(() => cache.read(0, BLOCK_BYTES + 1)).toThrow(RangeError)
		expect(() => cache.read(-1, 1)).toThrow(RangeError)
	})
})
