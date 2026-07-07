import { describe, expect, it } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem } from "@/lib/drive/item"

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

describe("narrowItem", () => {
	it("narrows a decoded directory: populated decryptedMeta, undecryptable false, synthetic 0n size", () => {
		const item = narrowItem(mockDir())

		if (item.type !== "directory") {
			throw new Error("expected a directory arm")
		}

		expect(item.data.decryptedMeta).toEqual({ name: "Documents" })
		expect(item.data.undecryptable).toBe(false)
		expect(item.data.size).toBe(0n) // synthetic — Dir has no native size field
		expect(item.data.uuid).toBe("11111111-1111-1111-1111-111111111111") // pass-through fields survive the spread
		expect(item.data.color).toBe("default")
	})

	it("narrows a decoded file: populated decryptedMeta, undecryptable false, native size preserved", () => {
		const item = narrowItem(mockFile())

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.decryptedMeta).toEqual(expect.objectContaining({ name: "report.pdf", mime: "application/pdf", version: 2 }))
		expect(item.data.undecryptable).toBe(false)
		expect(item.data.size).toBe(1_024n) // native File.size, not synthesized
	})

	it("marks a non-decoded directory meta as undecryptable with a null decryptedMeta", () => {
		const item = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		if (item.type !== "directory") {
			throw new Error("expected a directory arm")
		}

		expect(item.data.decryptedMeta).toBeNull()
		expect(item.data.undecryptable).toBe(true)
	})

	it("marks a non-decoded file meta as undecryptable with a null decryptedMeta", () => {
		const item = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.decryptedMeta).toBeNull()
		expect(item.data.undecryptable).toBe(true)
	})

	it("preserves bigint fields exactly, including magnitudes beyond Number.MAX_SAFE_INTEGER", () => {
		const hugeSize = 9_007_199_254_740_993n // 2^53 + 1 — would lose precision through Number()
		const item = narrowItem(mockFile({ size: hugeSize, timestamp: 1_234_567_890_123n, chunks: 42n }))

		if (item.type !== "file") {
			throw new Error("expected a file arm")
		}

		expect(item.data.size).toBe(hugeSize)
		expect(item.data.timestamp).toBe(1_234_567_890_123n)
		expect(item.data.chunks).toBe(42n)
	})

	it("narrows DriveItem.data by type at compile time — a file arm exposes mime, a directory arm cannot", () => {
		const fileItem = narrowItem(mockFile())
		if (fileItem.type === "file") {
			expect(fileItem.data.decryptedMeta?.mime).toBe("application/pdf")
		}

		const dirItem = narrowItem(mockDir())
		if (dirItem.type === "directory") {
			// @ts-expect-error -- a directory's decryptedMeta (DecryptedDirMeta) has no mime field; this
			// line must stay a type error, or the union has stopped narrowing `data` by `type`.
			void dirItem.data.decryptedMeta?.mime
		}
	})
})
