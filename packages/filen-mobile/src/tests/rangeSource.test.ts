// @vitest-environment happy-dom

// The reader closure `useRangeSource` hands to a WebView had no tests at all: the shared filesystem
// mock exposed `offset` as a getter, so a SEEK was inexpressible and the only thing under test was
// the pure bounds checker. That left the part that actually returns bytes — seek, short-read
// rejection, cumulative accounting, and the three refusals — riding on review alone. A dropped
// `handle.offset = offset` would have made every PDF range read return the wrong bytes, and nothing
// would have failed.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/logger", () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

import useRangeSource, { type RangeSource } from "@/hooks/useRangeSource"
import { PDF_MAGIC, base64ToBytes } from "@/lib/rangeTransfer"
import { fs } from "@/tests/mocks/expoFileSystem"

const URI = "file:///cache/probe.bin"

function seed(bytes: Uint8Array): void {
	fs.set(URI, bytes)
}

/** 0..255 repeating, so a wrong offset produces obviously wrong bytes. */
function pattern(length: number, from = 0): Uint8Array {
	const bytes = new Uint8Array(length)

	for (let index = 0; index < length; index++) {
		bytes[index] = (from + index) % 256
	}

	return bytes
}

async function open(config: { maxBytes?: number; magic?: string } = {}) {
	const { result } = renderHook(() =>
		useRangeSource(URI, {
			maxBytes: config.maxBytes ?? 1024 * 1024,
			magic: config.magic
		})
	)

	await waitFor(() => expect(result.current.status).not.toBe("pending"))

	return result
}

function ready(source: RangeSource): Extract<RangeSource, { status: "ready" }> {
	if (source.status !== "ready") {
		throw new Error(`expected a ready source, got ${source.status}`)
	}

	return source
}

beforeEach(() => {
	fs.clear()
	vi.clearAllMocks()
})

describe("useRangeSource", () => {
	it("returns the bytes at the requested offset, not the next bytes in sequence", async () => {
		// The whole point of a range reader. pdf.js reads randomly, so a reader that ignored the offset
		// and just streamed forward would still "work" for the sequential text/docx viewers and corrupt
		// every PDF.
		seed(pattern(1000))

		const result = await open()
		const source = ready(result.current)

		expect(base64ToBytes(await source.readRange(500, 4))).toEqual(pattern(4, 500))
		// Re-read an EARLIER range: only a real seek can satisfy this after the read above.
		expect(base64ToBytes(await source.readRange(0, 4))).toEqual(pattern(4, 0))
		expect(base64ToBytes(await source.readRange(996, 4))).toEqual(pattern(4, 996))
	})

	it("publishes the true size and reads the final byte", async () => {
		seed(pattern(333))

		const source = ready((await open()).current)

		expect(source.size).toBe(333)
		expect(base64ToBytes(await source.readRange(332, 1))).toEqual(pattern(1, 332))
	})

	it("refuses a read outside the file rather than returning short", async () => {
		// A clamped read looks like a truncated document to whatever is parsing it.
		seed(pattern(100))

		const source = ready((await open()).current)

		await expect(source.readRange(90, 20)).rejects.toThrow("range request refused")
		await expect(source.readRange(100, 1)).rejects.toThrow("range request refused")
		await expect(source.readRange(-1, 1)).rejects.toThrow("range request refused")
	})

	it("stops serving once the cumulative budget is spent", async () => {
		// Reads are synchronous on the JS thread, so an unbounded caller stalls the whole app rather
		// than merely its own WebView. The budget is a multiple of the file length.
		seed(pattern(100))

		const source = ready((await open()).current)

		for (let round = 0; round < 4; round++) {
			expect(base64ToBytes(await source.readRange(0, 100)).length).toBe(100)
		}

		await expect(source.readRange(0, 100)).rejects.toThrow("range request refused")
	})

	it("refuses a file larger than the viewer will open", async () => {
		seed(pattern(2048))

		const result = await open({ maxBytes: 1024 })

		expect(result.current.status).toBe("refused")
		expect(result.current).toMatchObject({ reason: "tooLarge" })
	})

	it("refuses a file whose header is not the expected signature", async () => {
		seed(new TextEncoder().encode("PK\x03\x04not a pdf"))

		const result = await open({ magic: PDF_MAGIC })

		expect(result.current.status).toBe("refused")
		expect(result.current).toMatchObject({ reason: "wrongFormat" })
	})

	it("accepts a file whose header matches", async () => {
		seed(new TextEncoder().encode("%PDF-1.7 rest of the document"))

		const result = await open({ magic: PDF_MAGIC })

		expect(result.current.status).toBe("ready")
	})

	it("refuses a file that is not there", async () => {
		const result = await open()

		expect(result.current.status).toBe("refused")
		expect(result.current).toMatchObject({ reason: "unreadable" })
	})

	it("stops serving after teardown", async () => {
		// The reader is handed to a WebView that outlives a React unmount by a moment; it must not keep
		// reading from a handle the component already closed.
		seed(pattern(100))

		const { result, unmount } = renderHook(() =>
			useRangeSource(URI, {
				maxBytes: 1024 * 1024
			})
		)

		await waitFor(() => expect(result.current.status).toBe("ready"))

		const source = ready(result.current)

		unmount()

		await expect(source.readRange(0, 4)).rejects.toThrow("range reader used after teardown")
	})
})
