// @vitest-environment happy-dom

// The write target is the second function a viewer's WebView can call into, so it gets the same
// treatment as the range reader: it is only open while a save the user asked for is in flight, it
// bounds every chunk, and it writes only to a temp file this side created.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@/lib/logger", () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

import useChunkedWriteTarget from "@/hooks/useChunkedWriteTarget"
import { MAX_RANGE_LENGTH, PDF_MAGIC, bytesToBase64 } from "@/lib/rangeTransfer"

function target(config?: { maxBytes?: number; magic?: string }) {
	return renderHook(() =>
		useChunkedWriteTarget({
			maxBytes: config?.maxBytes ?? 10 * 1024 * 1024,
			magic: config?.magic,
			fileName: "test.txt"
		})
	).result.current
}

const chunk = (byteLength: number) => bytesToBase64(new Uint8Array(byteLength))

describe("useChunkedWriteTarget", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("refuses to write when no save is in progress", async () => {
		// Without this a document could stage a file at a time of its own choosing, rather than only
		// while the user is saving.
		await expect(target().writeChunk(chunk(16))).rejects.toThrow("no save in progress")
	})

	it("refuses a chunk that is not a non-empty string", async () => {
		const writer = target()

		writer.begin()

		await expect(writer.writeChunk("")).rejects.toThrow("chunk must be a non-empty string")
		await expect(writer.writeChunk(null as unknown as string)).rejects.toThrow("chunk must be a non-empty string")
	})

	it("refuses a chunk larger than the bridge allows", async () => {
		const writer = target()

		writer.begin()

		await expect(writer.writeChunk(chunk(MAX_RANGE_LENGTH + 1))).rejects.toThrow("chunk out of bounds")
	})

	it("enforces the size ceiling across chunks, not just per chunk", async () => {
		// Each chunk is individually legal; the point is that they cannot be used to exceed the limit
		// in aggregate.
		const writer = target({ maxBytes: 3000 })

		writer.begin()

		await writer.writeChunk(chunk(2000))

		await expect(writer.writeChunk(chunk(2000))).rejects.toThrow("save exceeds the size limit")
	})

	it("starts a fresh budget on each save", async () => {
		const writer = target({ maxBytes: 3000 })

		writer.begin()

		await writer.writeChunk(chunk(2000))

		writer.begin()

		await expect(writer.writeChunk(chunk(2000))).resolves.toBeUndefined()
	})

	it("returns an empty document as a real result", () => {
		// Deleting a file's contents and saving is a legitimate edit, so "nothing was written" must
		// mean the empty document — not a failed save. A format that cannot be empty is caught by its
		// magic check instead.
		const writer = target()

		writer.begin()

		expect(writer.finish()).not.toBeNull()
	})

	it("rejects a result whose header is not the configured signature", () => {
		// Nothing was streamed, so the staged file has no PDF header — which is exactly the shape of a
		// viewer returning something that must not replace the user's document.
		const writer = target({ magic: PDF_MAGIC })

		writer.begin()

		expect(writer.finish()).toBeNull()
	})

	it("returns nothing when finish is called without a save", () => {
		expect(target().finish()).toBeNull()
	})

	it("disarms after discard", async () => {
		const writer = target()

		writer.begin()
		writer.discard()

		await expect(writer.writeChunk(chunk(16))).rejects.toThrow("no save in progress")
		expect(writer.finish()).toBeNull()
	})
})
