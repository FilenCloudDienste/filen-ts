import { describe, expect, it, vi } from "vitest"
import { EndOfStreamError } from "strtok3"
import {
	BLOCK_BYTES,
	BlockReadError,
	BlockSource,
	BlockTokenizer,
	MAX_BLOCK_READS,
	ReadBudgetError
} from "@/features/audio/lib/blockTokenizer"

// A file whose every byte is its offset mod 251, so any window read back can be checked in place.
function byteAt(offset: number): number {
	return offset % 251
}

function makeReader(size: number): ReturnType<typeof vi.fn<(start: number, end: number) => Promise<Uint8Array>>> {
	return vi.fn<(start: number, end: number) => Promise<Uint8Array>>((start, end) => {
		const out = new Uint8Array(Math.min(end, size) - start)

		for (let i = 0; i < out.length; i++) {
			out[i] = byteAt(start + i)
		}

		return Promise.resolve(out)
	})
}

function expectWindow(buffer: Uint8Array, position: number): void {
	for (let i = 0; i < buffer.length; i++) {
		expect(buffer[i]).toBe(byteAt(position + i))
	}
}

describe("BlockTokenizer", () => {
	it("downloads whole aligned blocks and serves every small read inside one from the cache", async () => {
		const size = BLOCK_BYTES * 3
		const reader = makeReader(size)
		const tokenizer = new BlockTokenizer(new BlockSource(size, reader))
		const head = new Uint8Array(10)
		const tag = new Uint8Array(128)

		await tokenizer.readBuffer(head)
		await tokenizer.peekBuffer(tag, { position: 4096 })

		expect(reader).toHaveBeenCalledTimes(1)
		expect(reader).toHaveBeenCalledWith(0, BLOCK_BYTES)
		expectWindow(head, 0)
		expectWindow(tag, 4096)
	})

	it("stitches a read that crosses a block boundary", async () => {
		const size = BLOCK_BYTES * 2 + 100
		const reader = makeReader(size)
		const tokenizer = new BlockTokenizer(new BlockSource(size, reader))
		const window = new Uint8Array(64)

		await tokenizer.peekBuffer(window, { position: BLOCK_BYTES - 32 })

		expect(reader.mock.calls).toEqual([
			[0, BLOCK_BYTES],
			[BLOCK_BYTES, BLOCK_BYTES * 2]
		])
		expectWindow(window, BLOCK_BYTES - 32)
	})

	it("clamps the last block to the file size", async () => {
		const size = BLOCK_BYTES + 300
		const reader = makeReader(size)
		const tokenizer = new BlockTokenizer(new BlockSource(size, reader))
		const tail = new Uint8Array(128)

		await tokenizer.peekBuffer(tail, { position: size - 128 })

		expect(reader).toHaveBeenCalledWith(BLOCK_BYTES, size)
		expectWindow(tail, size - 128)
	})

	it("advances on readBuffer but not on peekBuffer", async () => {
		const tokenizer = new BlockTokenizer(new BlockSource(1000, makeReader(1000)))
		const buffer = new Uint8Array(10)

		await tokenizer.peekBuffer(buffer)
		expect(tokenizer.position).toBe(0)

		await tokenizer.readBuffer(buffer)
		expect(tokenizer.position).toBe(10)
	})

	it("throws EndOfStreamError past the end unless mayBeLess is set, which returns a short read", async () => {
		const reader = makeReader(100)
		const tokenizer = new BlockTokenizer(new BlockSource(100, reader))
		const buffer = new Uint8Array(50)

		await expect(tokenizer.peekBuffer(buffer, { position: 80 })).rejects.toBeInstanceOf(EndOfStreamError)
		await expect(tokenizer.peekBuffer(buffer, { position: 80, mayBeLess: true })).resolves.toBe(20)
		await expect(tokenizer.peekBuffer(buffer, { position: 100, mayBeLess: true })).resolves.toBe(0)
	})

	it("skips over the body with ignore() without downloading it", async () => {
		const size = BLOCK_BYTES * 5
		const reader = makeReader(size)
		const tokenizer = new BlockTokenizer(new BlockSource(size, reader))

		await tokenizer.ignore(BLOCK_BYTES * 4)
		await tokenizer.readBuffer(new Uint8Array(8))

		expect(reader.mock.calls).toEqual([[BLOCK_BYTES * 4, BLOCK_BYTES * 5]])
	})

	it("carries the mime hint only when given one, and reports random access", () => {
		const source = new BlockSource(10, makeReader(10))

		expect(new BlockTokenizer(source).fileInfo).toEqual({ size: 10 })
		expect(new BlockTokenizer(source, "audio/flac").fileInfo).toEqual({ size: 10, mimeType: "audio/flac" })
		expect(new BlockTokenizer(source).supportsRandomAccess()).toBe(true)
	})
})

describe("BlockSource", () => {
	it("shares its cache across tokenizers, so a second parse pass downloads nothing", async () => {
		const reader = makeReader(5000)
		const source = new BlockSource(5000, reader)

		await new BlockTokenizer(source).readBuffer(new Uint8Array(100))
		await new BlockTokenizer(source, "audio/mpeg").readBuffer(new Uint8Array(100))

		expect(reader).toHaveBeenCalledTimes(1)
	})

	it("keeps the first download failure and fails a repeat read of that block without downloading again", async () => {
		const reader = vi.fn(() => Promise.reject(new Error("network")))
		const source = new BlockSource(5000, reader)
		const tokenizer = new BlockTokenizer(source)

		await expect(tokenizer.readBuffer(new Uint8Array(10))).rejects.toBeInstanceOf(BlockReadError)
		await expect(tokenizer.peekBuffer(new Uint8Array(10), { position: 0 })).rejects.toBeInstanceOf(BlockReadError)

		expect(source.readError).toBeInstanceOf(BlockReadError)
		expect(reader).toHaveBeenCalledTimes(1)
	})

	it("treats a short block from the transport as a read failure", async () => {
		const source = new BlockSource(5000, () => Promise.resolve(new Uint8Array(10)))

		await expect(new BlockTokenizer(source).readBuffer(new Uint8Array(20))).rejects.toBeInstanceOf(BlockReadError)
		expect(source.readError).not.toBeNull()
	})

	it("refuses to download more blocks than tags ever need", async () => {
		const size = BLOCK_BYTES * (MAX_BLOCK_READS + 2)
		const reader = makeReader(size)
		const tokenizer = new BlockTokenizer(new BlockSource(size, reader))

		for (let i = 0; i < MAX_BLOCK_READS; i++) {
			await tokenizer.peekBuffer(new Uint8Array(1), { position: i * BLOCK_BYTES })
		}

		await expect(tokenizer.peekBuffer(new Uint8Array(1), { position: MAX_BLOCK_READS * BLOCK_BYTES })).rejects.toBeInstanceOf(
			ReadBudgetError
		)
		expect(reader).toHaveBeenCalledTimes(MAX_BLOCK_READS)
	})
})
