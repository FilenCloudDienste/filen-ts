import { describe, expect, it, vi } from "vitest"
import { RangeFetchTokenizer } from "@/features/audio/lib/rangeTokenizer"

const FILE_SIZE = 100

function fakeFile(): Uint8Array {
	const bytes = new Uint8Array(FILE_SIZE)

	for (let i = 0; i < FILE_SIZE; i++) {
		bytes[i] = i % 256
	}

	return bytes
}

function makeFetch(file: Uint8Array): { fetchImpl: typeof fetch; requests: string[] } {
	const requests: string[] = []

	const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
		const range = (init?.headers as Record<string, string> | undefined)?.["Range"] ?? ""

		requests.push(range)

		const match = /bytes=(\d+)-(\d+)/.exec(range)

		if (!match) {
			throw new Error("missing range header")
		}

		const start = Number(match[1])
		const end = Number(match[2])
		const chunk = file.slice(start, Math.min(end + 1, file.length))

		return Promise.resolve({
			ok: true,
			status: 206,
			arrayBuffer: () => Promise.resolve(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))
		} as Response)
	}) as unknown as typeof fetch

	return { fetchImpl, requests }
}

describe("RangeFetchTokenizer", () => {
	it("issues a Range request for exactly the requested window and fills the buffer", async () => {
		const file = fakeFile()
		const { fetchImpl, requests } = makeFetch(file)
		const tokenizer = new RangeFetchTokenizer("/sw/download/x", FILE_SIZE, "audio/mpeg", fetchImpl)

		const out = new Uint8Array(10)
		const read = await tokenizer.readBuffer(out, { position: 5, length: 10 })

		expect(read).toBe(10)
		expect(requests).toEqual(["bytes=5-14"])
		expect(Array.from(out)).toEqual(Array.from(file.slice(5, 15)))
	})

	it("advances position on readBuffer but not on peekBuffer", async () => {
		const file = fakeFile()
		const { fetchImpl } = makeFetch(file)
		const tokenizer = new RangeFetchTokenizer("/sw/download/x", FILE_SIZE, "audio/mpeg", fetchImpl)

		await tokenizer.readBuffer(new Uint8Array(4), { position: 0, length: 4 })
		expect(tokenizer.position).toBe(4)

		await tokenizer.peekBuffer(new Uint8Array(4), { position: 4, length: 4 })
		expect(tokenizer.position).toBe(4)
	})

	it("throws EndOfStreamError past the file end unless mayBeLess is set, which returns a short read", async () => {
		const file = fakeFile()
		const { fetchImpl } = makeFetch(file)
		const tokenizer = new RangeFetchTokenizer("/sw/download/x", FILE_SIZE, "audio/mpeg", fetchImpl)

		await expect(tokenizer.readBuffer(new Uint8Array(10), { position: FILE_SIZE - 5, length: 10 })).rejects.toThrow()

		const out = new Uint8Array(10)
		const read = await tokenizer.readBuffer(out, { position: FILE_SIZE - 5, length: 10, mayBeLess: true })

		expect(read).toBe(5)
	})

	it("reports random-access support and setPosition moves the cursor without a fetch", () => {
		const file = fakeFile()
		const { fetchImpl, requests } = makeFetch(file)
		const tokenizer = new RangeFetchTokenizer("/sw/download/x", FILE_SIZE, "audio/mpeg", fetchImpl)

		expect(tokenizer.supportsRandomAccess()).toBe(true)

		tokenizer.setPosition(20)
		expect(tokenizer.position).toBe(20)
		expect(requests).toHaveLength(0)
	})
})
