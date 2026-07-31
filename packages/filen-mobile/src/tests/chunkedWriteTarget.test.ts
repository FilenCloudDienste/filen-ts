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

import useChunkedWriteTarget, { SAVE_HEADROOM_BYTES } from "@/hooks/useChunkedWriteTarget"
import { MAX_RANGE_LENGTH, PDF_MAGIC, bytesToBase64 } from "@/lib/rangeTransfer"
import { fs } from "@/tests/mocks/expoFileSystem"

function target(config?: { maxBytes?: number; magic?: string; headroomBytes?: number }) {
	return renderHook(() =>
		useChunkedWriteTarget({
			maxBytes: config?.maxBytes ?? 10 * 1024 * 1024,
			magic: config?.magic,
			fileName: "test.txt",
			// Most tests want the ceiling to be exactly maxBytes; the headroom gets its own test below.
			headroomBytes: config?.headroomBytes ?? 0
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
	it("leaves room above the open ceiling for what the edit added", () => {
		// Call sites pass the same limit they used to decide whether to OPEN the file, and the open gate
		// admits a file at exactly that size. Without headroom a document at the cap could be opened and
		// edited but never saved: every attempt failed on the last chunk, deterministically.
		expect(SAVE_HEADROOM_BYTES).toBeGreaterThan(0)
	})

	it("applies the headroom by default", async () => {
		const writer = target({ maxBytes: 1000, headroomBytes: 8000 })

		writer.begin()

		// Past maxBytes, inside the headroom.
		await expect(writer.writeChunk(chunk(4000))).resolves.toBeUndefined()

		// Past maxBytes + headroom.
		await expect(writer.writeChunk(chunk(6000))).rejects.toThrow("save exceeds the size limit")
	})
	// ── The accept branch ───────────────────────────────────────────────────────
	//
	// Everything above proves the target REFUSES things. Until the filesystem mock grew real writes,
	// nothing proved it accepts one correctly: `writeBytes` was a no-op, so a streamed document was
	// never actually written and never read back. A byte-corrupting bug in this path uploads garbage
	// over the user's cloud file, which is the worst outcome the whole design exists to prevent.

	it("reassembles a streamed document byte for byte, in order", async () => {
		const writer = target()
		const file = writer.begin()

		// Distinct, order-sensitive chunks: a swapped or dropped chunk changes the result.
		await writer.writeChunk(bytesToBase64(new Uint8Array([1, 2, 3])))
		await writer.writeChunk(bytesToBase64(new Uint8Array([4, 5])))
		await writer.writeChunk(bytesToBase64(new Uint8Array([6, 7, 8, 9])))

		expect(writer.finish()).not.toBeNull()
		expect(Array.from(fs.get(file.uri) as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
	})

	it("accepts a result whose header matches the configured signature", async () => {
		// The magic check's ACCEPT path. The only magic test before this one staged an empty file and
		// asserted rejection, so a check that rejected everything would have passed.
		const writer = target({ magic: PDF_MAGIC })

		writer.begin()

		await writer.writeChunk(bytesToBase64(new TextEncoder().encode("%PDF-1.7\n1 0 obj")))

		expect(writer.finish()).not.toBeNull()
	})

	it("rejects a result whose header is wrong even though bytes were written", async () => {
		const writer = target({ magic: PDF_MAGIC })

		writer.begin()

		await writer.writeChunk(bytesToBase64(new TextEncoder().encode("PK\x03\x04 not a pdf")))

		expect(writer.finish()).toBeNull()
	})

	it("does not carry bytes from one save into the next", async () => {
		// The staging path is fixed, so a second save re-creates the same file. If that did not
		// truncate, the leftover head of save #1 would prefix save #2 — and for a PDF the spliced
		// result still starts with %PDF-, so the magic check would wave it through on its way to
		// replacing the user's document.
		const writer = target()

		writer.begin()

		await writer.writeChunk(bytesToBase64(new Uint8Array([9, 9, 9, 9, 9, 9])))

		const second = writer.begin()

		await writer.writeChunk(bytesToBase64(new Uint8Array([1, 2])))

		expect(writer.finish()).not.toBeNull()
		expect(Array.from(fs.get(second.uri) as Uint8Array)).toEqual([1, 2])
	})

	it("deletes what it wrote when the save is discarded", async () => {
		const writer = target()
		const file = writer.begin()

		await writer.writeChunk(bytesToBase64(new Uint8Array([1, 2, 3])))

		writer.discard()

		expect(fs.get(file.uri)).toBeUndefined()
	})
})
