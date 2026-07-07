import { describe, expect, it } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem } from "@/lib/drive/item"
import { formatItemSize, formatModifiedDate } from "@/lib/drive/format"

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

function expectedDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

describe("formatItemSize", () => {
	it("formats a file's byte size", () => {
		expect(formatItemSize(narrowItem(mockFile({ size: 2_048n })))).toBe("2 KiB")
	})

	it("returns an empty string for a directory — it carries no real size on the item itself", () => {
		expect(formatItemSize(narrowItem(mockDir()))).toBe("")
	})
})

describe("formatModifiedDate", () => {
	it("uses decryptedMeta.modified for a file when present", () => {
		const item = narrowItem(
			mockFile({
				timestamp: 1n,
				meta: {
					type: "decoded",
					data: { name: "x", mime: "text/plain", modified: 1_700_000_000_000n, size: 1n, key: "k", version: 2 }
				}
			})
		)

		expect(formatModifiedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("falls back to the item's own timestamp for an undecryptable file", () => {
		const item = narrowItem(mockFile({ timestamp: 1_700_000_000_000n, meta: { type: "encrypted", data: "ciphertext" } }))

		expect(formatModifiedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("uses decryptedMeta.created for a directory when present", () => {
		const item = narrowItem(
			mockDir({ timestamp: 1n, meta: { type: "decoded", data: { name: "Documents", created: 1_700_000_000_000n } } })
		)

		expect(formatModifiedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("falls back to the item's own timestamp for a directory with no created field", () => {
		const item = narrowItem(mockDir({ timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name: "Documents" } } }))

		expect(formatModifiedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})
})
