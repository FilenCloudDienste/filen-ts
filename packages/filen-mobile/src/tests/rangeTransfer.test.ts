import { describe, expect, test, vi } from "vitest"
import {
	MAX_RANGE_LENGTH,
	PDF_MAGIC,
	ZIP_MAGIC,
	base64ToBytes,
	bytesToBase64,
	checkRangeRequest,
	hasMagic,
	readAllBytes,
	readAllText,
	writeAllBytes,
	type RangeReader
} from "@/lib/rangeTransfer"

const SIZE = 10 * 1024 * 1024
const LIMIT = SIZE * 4

function check(overrides: Partial<Parameters<typeof checkRangeRequest>[0]> = {}) {
	return checkRangeRequest({
		offset: 0,
		length: 1024,
		size: SIZE,
		bytesRead: 0,
		cumulativeLimit: LIMIT,
		...overrides
	})
}

/** A reader over an in-memory file, with the same contract as the real one (rejects, never clamps). */
function readerOver(bytes: Uint8Array): RangeReader {
	return async (offset: number, length: number) => {
		if (offset < 0 || offset >= bytes.byteLength || length <= 0 || offset + length > bytes.byteLength) {
			throw new Error("range request refused")
		}

		return bytesToBase64(bytes.subarray(offset, offset + length))
	}
}

/**
 * This is the security boundary for the only function the WebView can call into. A hostile document
 * that achieves script execution calls it directly, with whatever arguments it likes.
 */
describe("checkRangeRequest", () => {
	test("allows an ordinary read", () => {
		expect(check()).toBeNull()
		expect(check({ offset: SIZE - 1, length: 1 })).toBeNull()
		expect(check({ length: MAX_RANGE_LENGTH })).toBeNull()
	})

	test("rejects non-integers, including the shapes that coerce", () => {
		for (const value of [1.5, NaN, Infinity, -Infinity]) {
			expect(check({ offset: value })).toBe("notInteger")
			expect(check({ length: value })).toBe("notInteger")
		}
	})

	test("rejects reads outside the file", () => {
		expect(check({ offset: -1 })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE + 1024 })).toBe("offsetOutOfRange")
		expect(check({ offset: SIZE - 10, length: 1024 })).toBe("exceedsFile")
	})

	test("rejects an oversized or empty length", () => {
		expect(check({ length: 0 })).toBe("lengthOutOfBounds")
		expect(check({ length: -1 })).toBe("lengthOutOfBounds")
		expect(check({ length: MAX_RANGE_LENGTH + 1 })).toBe("lengthOutOfBounds")
	})

	test("rejects once the cumulative budget is spent", () => {
		// Reads are synchronous on the JS thread, so without this a caller can stall the whole app
		// rather than merely its own WebView.
		expect(check({ bytesRead: LIMIT, length: 1 })).toBe("cumulativeLimit")
		expect(check({ bytesRead: LIMIT - 512, length: 1024 })).toBe("cumulativeLimit")
		expect(check({ bytesRead: LIMIT - 1024, length: 1024 })).toBeNull()
	})

	test("never clamps — every refusal is a rejection", () => {
		// A clamped read returns fewer bytes than the parser asked for, which it reports as a damaged
		// document. Bounds failures must not be able to masquerade as a corrupt file.
		const past = check({ offset: SIZE - 10, length: 4096 })

		expect(past).not.toBeNull()
		expect(past).toBe("exceedsFile")
	})

	test("ignores any field it was not asked to consider", () => {
		// The reader takes (offset, length) and nothing else — a path parameter would make it an
		// arbitrary-file-read primitive. That shape is a type-level guarantee, NOT something this
		// assertion can prove: an earlier version checked `checkRangeRequest.length === 1`, which is
		// true of any destructured-object function no matter what fields it declares, so it passed
		// with `path` added. What is checkable here is that an extra field cannot influence a verdict.
		const withExtra = checkRangeRequest({
			offset: 0,
			length: 1024,
			size: SIZE,
			bytesRead: 0,
			cumulativeLimit: LIMIT,
			...({ path: "/etc/passwd" } as unknown as Record<string, never>)
		})

		expect(withExtra).toBe(check())
	})
})

describe("hasMagic", () => {
	test("accepts only an exact header", () => {
		expect(hasMagic("%PDF-", PDF_MAGIC)).toBe(true)
		expect(hasMagic("%pdf-", PDF_MAGIC)).toBe(false)
		expect(hasMagic("PK", PDF_MAGIC)).toBe(false)
		expect(hasMagic("", PDF_MAGIC)).toBe(false)
		expect(hasMagic("%PDF", PDF_MAGIC)).toBe(false)
		// The full local-file-header signature, not a bare "PK": that also prefixes an empty archive
		// (PK\x05\x06) and a spanned one (PK\x07\x08), neither of which is a document.
		expect(ZIP_MAGIC).toBe("PK\x03\x04")
		expect(hasMagic("PK\x03\x04", ZIP_MAGIC)).toBe(true)
		expect(hasMagic("PK", ZIP_MAGIC)).toBe(false)
		expect(hasMagic("PK\x05\x06", ZIP_MAGIC)).toBe(false)
	})
})

describe("base64 codec", () => {
	test("round-trips every byte value", () => {
		const bytes = new Uint8Array(256)

		for (let index = 0; index < 256; index++) {
			bytes[index] = index
		}

		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
	})

	test("round-trips across the encoder's stride boundary", () => {
		// The encoder batches String.fromCharCode calls; a payload spanning several batches is the case
		// that would drop or duplicate bytes if the striding were wrong.
		const bytes = new Uint8Array(8192 * 2 + 5)

		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = index % 256
		}

		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
	})

	test("round-trips empty input", () => {
		expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0))
	})
})

describe("readAllBytes", () => {
	test("reassembles a file split across many chunks", async () => {
		const bytes = new Uint8Array(1000)

		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = index % 256
		}

		expect(await readAllBytes(readerOver(bytes), bytes.byteLength, { chunkSize: 64 })).toEqual(bytes)
	})

	test("reads an empty file without ever calling the reader", async () => {
		const read = vi.fn()

		expect(await readAllBytes(read, 0)).toEqual(new Uint8Array(0))
		expect(read).not.toHaveBeenCalled()
	})

	test("never asks for more than the bridge allows, even when told to", async () => {
		const lengths: number[] = []
		const read: RangeReader = async (_offset, length) => {
			lengths.push(length)

			return bytesToBase64(new Uint8Array(length))
		}

		await readAllBytes(read, MAX_RANGE_LENGTH * 2, {
			chunkSize: MAX_RANGE_LENGTH * 2
		})

		expect(lengths.every(length => length <= MAX_RANGE_LENGTH)).toBe(true)
	})

	test("throws on a short chunk rather than assembling a file with a hole in it", async () => {
		const read: RangeReader = async () => bytesToBase64(new Uint8Array(1))

		await expect(readAllBytes(read, 100, { chunkSize: 50 })).rejects.toThrow("short read")
	})

	test("stops and returns null when cancelled part-way", async () => {
		const bytes = new Uint8Array(1000)
		let calls = 0
		const read: RangeReader = async (offset, length) => {
			calls++

			return bytesToBase64(bytes.subarray(offset, offset + length))
		}

		expect(
			await readAllBytes(read, bytes.byteLength, {
				chunkSize: 100,
				isCancelled: () => calls >= 3
			})
		).toBeNull()

		expect(calls).toBe(3)
	})

	test("reports progress against the total", async () => {
		const bytes = new Uint8Array(300)
		const progress: number[] = []

		await readAllBytes(readerOver(bytes), bytes.byteLength, {
			chunkSize: 100,
			onProgress: transferred => progress.push(transferred)
		})

		expect(progress).toEqual([100, 200, 300])
	})
})

describe("readAllText", () => {
	test("decodes a multi-byte character straddling a chunk boundary", async () => {
		// The whole reason the decode is streamed. Decoding each chunk independently would turn the
		// split character into two replacement characters.
		const text = "aé😀b"
		const bytes = new TextEncoder().encode(text)

		for (let chunkSize = 1; chunkSize <= bytes.byteLength; chunkSize++) {
			expect(await readAllText(readerOver(bytes), bytes.byteLength, { chunkSize })).toBe(text)
		}
	})

	test("reads an empty file as an empty string", async () => {
		expect(await readAllText(readerOver(new Uint8Array(0)), 0)).toBe("")
	})

	test("yields replacement characters for undecodable bytes rather than throwing", async () => {
		// Binary behind a text extension must reach the caller as U+FFFD soup so the binary-content gate
		// can refuse it — a throw here would surface as a load failure instead.
		const bytes = new Uint8Array([0xff, 0xfe, 0xff, 0xfe])
		const decoded = await readAllText(readerOver(bytes), bytes.byteLength, { chunkSize: 2 })

		expect(decoded).not.toBeNull()
		expect(decoded).toContain("�")
	})

	test("flushes an incomplete trailing sequence", async () => {
		// A truncated multi-byte character at EOF is held back by the streaming decoder until the final
		// flush; without it the tail would silently vanish.
		const bytes = new Uint8Array([0x61, 0xc3])

		expect(await readAllText(readerOver(bytes), bytes.byteLength, { chunkSize: 1 })).toBe("a�")
	})

	test("stops and returns null when cancelled part-way", async () => {
		const bytes = new TextEncoder().encode("hello world")

		expect(
			await readAllText(readerOver(bytes), bytes.byteLength, {
				chunkSize: 2,
				isCancelled: () => true
			})
		).toBeNull()
	})
})

describe("writeAllBytes", () => {
	test("streams the whole document in bounded chunks", async () => {
		const bytes = new Uint8Array(1000)

		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = index % 256
		}

		const received: number[] = []

		expect(
			await writeAllBytes(
				bytes,
				async chunk => {
					received.push(...base64ToBytes(chunk))
				},
				{ chunkSize: 128 }
			)
		).toBe(true)

		expect(new Uint8Array(received)).toEqual(bytes)
	})

	test("caps the chunk size at the bridge limit however it is called", async () => {
		const sizes: number[] = []

		await writeAllBytes(
			new Uint8Array(MAX_RANGE_LENGTH + 10),
			async chunk => {
				sizes.push(base64ToBytes(chunk).byteLength)
			},
			{ chunkSize: MAX_RANGE_LENGTH * 4 }
		)

		expect(sizes.every(size => size <= MAX_RANGE_LENGTH)).toBe(true)
	})

	test("writes nothing for an empty document", async () => {
		const write = vi.fn()

		expect(await writeAllBytes(new Uint8Array(0), write)).toBe(true)
		expect(write).not.toHaveBeenCalled()
	})

	test("stops and reports false when cancelled part-way", async () => {
		let calls = 0

		expect(
			await writeAllBytes(
				new Uint8Array(1000),
				async () => {
					calls++
				},
				{
					chunkSize: 100,
					isCancelled: () => calls >= 2
				}
			)
		).toBe(false)

		expect(calls).toBe(2)
	})
})
