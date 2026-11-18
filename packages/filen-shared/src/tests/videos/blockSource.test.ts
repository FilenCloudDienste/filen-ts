import { describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES, BlockSource, MAX_BLOCK_READS, ReadBudgetError } from "@filen/shared/videos"

// A virtual file: each block is filled with its index plus one, so a read shows which block it came from.
function countingReader() {
	return vi.fn((start: number, end: number) => Promise.resolve(new Uint8Array(end - start).fill((start / BLOCK_BYTES + 1) & 0xff)))
}

async function readByte(source: BlockSource, position: number): Promise<number> {
	const target = new Uint8Array(1)

	await source.read(target, position, 1)

	return target[0] ?? -1
}

describe("BlockSource cache", () => {
	it("keeps a block it returns to resident, evicting the least recently used one instead", async () => {
		const reader = countingReader()
		const source = new BlockSource(BLOCK_BYTES * 3, reader, { cachedBlocks: 2 })

		for (const index of [0, 1, 0, 2, 0]) {
			await readByte(source, index * BLOCK_BYTES)
		}

		expect(reader).toHaveBeenCalledTimes(3)

		await readByte(source, BLOCK_BYTES)

		expect(reader).toHaveBeenCalledTimes(4)
		expect(source.blockReads).toBe(4)
	})

	it("hands out a resident block without downloading, and null for one never read", async () => {
		const reader = countingReader()
		const source = new BlockSource(BLOCK_BYTES * 2, reader)

		expect(await source.residentBlock(BLOCK_BYTES + 5)).toBeNull()
		expect(reader).not.toHaveBeenCalled()

		await readByte(source, 10)

		const resident = await source.residentBlock(BLOCK_BYTES - 1)

		expect(resident?.length).toBe(BLOCK_BYTES)
		expect(resident?.[0]).toBe(1)
		// Shared, not copied: the very buffer the reader produced, on every call.
		expect(resident).toBe(await reader.mock.results[0]?.value)
		expect(await source.residentBlock(0)).toBe(resident)
		expect(await source.residentBlock(BLOCK_BYTES)).toBeNull()
		expect(reader).toHaveBeenCalledTimes(1)
	})

	it("reports a block cached until it is evicted", async () => {
		const source = new BlockSource(BLOCK_BYTES * 3, countingReader(), { cachedBlocks: 2 })

		expect(source.isCached(0)).toBe(false)

		await readByte(source, 0)
		await readByte(source, BLOCK_BYTES)

		expect(source.isCached(BLOCK_BYTES - 1)).toBe(true)
		expect(source.isCached(BLOCK_BYTES)).toBe(true)
		expect(source.isCached(BLOCK_BYTES * 2)).toBe(false)

		await readByte(source, BLOCK_BYTES * 2)

		expect(source.isCached(0)).toBe(false)
		expect(source.isCached(BLOCK_BYTES)).toBe(true)
		expect(source.isCached(BLOCK_BYTES * 2)).toBe(true)
	})
})

describe("BlockSource budget", () => {
	it("only ever raises the budget", () => {
		const source = new BlockSource(BLOCK_BYTES, countingReader())

		expect(source.blockBudget).toBe(MAX_BLOCK_READS)

		source.allowBlockReads(2)

		expect(source.blockBudget).toBe(MAX_BLOCK_READS)

		source.allowBlockReads(MAX_BLOCK_READS + 2)

		expect(source.blockBudget).toBe(MAX_BLOCK_READS + 2)
	})

	it("charges the budget again for an evicted block read a second time", async () => {
		const reader = countingReader()
		const source = new BlockSource(BLOCK_BYTES * 2, reader, { maxBlockReads: 2, cachedBlocks: 1 })

		await readByte(source, 0)
		await readByte(source, BLOCK_BYTES)

		await expect(readByte(source, 0)).rejects.toBeInstanceOf(ReadBudgetError)
		expect(reader).toHaveBeenCalledTimes(2)

		source.allowBlockReads(3)

		expect(await readByte(source, 0)).toBe(1)
		expect(source.blockReads).toBe(3)
	})
})

describe("BlockSource reads", () => {
	it("fills a read across a block boundary and clamps the last block to the file size", async () => {
		const reader = countingReader()
		const size = BLOCK_BYTES + 100
		const source = new BlockSource(size, reader)
		const target = new Uint8Array(20)

		await source.read(target, BLOCK_BYTES - 10, 20)

		expect(Array.from(target)).toEqual([...new Array<number>(10).fill(1), ...new Array<number>(10).fill(2)])
		expect(reader.mock.calls).toEqual([
			[0, BLOCK_BYTES],
			[BLOCK_BYTES, size]
		])
	})
})
