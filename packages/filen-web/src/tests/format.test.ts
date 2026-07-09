import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharingRole } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import {
	formatCreatedDate,
	formatItemSize,
	formatModifiedDate,
	formatVersionTimestamp,
	sharedIdentityLabel
} from "@/features/drive/lib/format"

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

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

// A SharedFile has no `favorited` field, so narrowItem resolves it to a sharedRootFile — one of the
// three arms getSharerIdentity reads its sharingRole directly off of (see item.ts).
function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: "44444444-4444-4444-4444-444444444444",
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		sharedTag: true,
		...overrides
	}
}

// A bare SharedDir (no fetcher-spread sharingRole) narrows to a sharedDirectory whose data.sharingRole
// is undefined — getSharerIdentity has nothing to read and no resolver is passed in these tests.
function mockSharedDir(overrides: Partial<SharedDir> = {}): SharedDir {
	return {
		inner: mockDir({ uuid: "55555555-5555-5555-5555-555555555555", meta: { type: "decoded", data: { name: "SharedChild" } } }),
		sharedTag: true,
		...overrides
	}
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

describe("formatCreatedDate", () => {
	it("uses decryptedMeta.created for a file when present", () => {
		const item = narrowItem(
			mockFile({
				timestamp: 1n,
				meta: {
					type: "decoded",
					data: { name: "x", mime: "text/plain", created: 1_700_000_000_000n, modified: 2n, size: 1n, key: "k", version: 2 }
				}
			})
		)

		expect(formatCreatedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("falls back to the item's own timestamp for a file with no created field", () => {
		const item = narrowItem(
			mockFile({
				timestamp: 1_700_000_000_000n,
				meta: { type: "decoded", data: { name: "x", mime: "text/plain", modified: 2n, size: 1n, key: "k", version: 2 } }
			})
		)

		expect(formatCreatedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("uses decryptedMeta.created for a directory when present", () => {
		const item = narrowItem(
			mockDir({ timestamp: 1n, meta: { type: "decoded", data: { name: "Documents", created: 1_700_000_000_000n } } })
		)

		expect(formatCreatedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})

	it("falls back to the item's own timestamp for an undecryptable item", () => {
		const item = narrowItem(mockDir({ timestamp: 1_700_000_000_000n, meta: { type: "encrypted", data: "ciphertext" } }))

		expect(formatCreatedDate(item)).toBe(expectedDate(1_700_000_000_000))
	})
})

describe("formatVersionTimestamp", () => {
	it("includes both date and time, matching Intl's medium-date/short-time output for the same instant", () => {
		const ms = 1_700_000_000_000
		const expected = new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

		expect(formatVersionTimestamp(BigInt(ms))).toBe(expected)
	})

	it("distinguishes two timestamps that land on the same calendar day but a different time", () => {
		const morning = formatVersionTimestamp(1_700_000_000_000n)
		const laterSameDay = formatVersionTimestamp(1_700_000_000_000n + 60n * 60n * 1000n)

		expect(morning).not.toBe(laterSameDay)
	})
})

describe("sharedIdentityLabel", () => {
	it("returns null for a non-shared variant regardless of the item", () => {
		expect(sharedIdentityLabel(narrowItem(mockDir()), "drive")).toBeNull()
	})

	it("returns null on a shared variant when the item's role can't be read", () => {
		const item = narrowItem(mockSharedDir())

		expect(sharedIdentityLabel(item, "sharedIn")).toBeNull()
	})

	it("labels a resolvable identity on sharedIn with driveSharedByLabel — who shared it with me", () => {
		const item = narrowItem(mockSharedFile())

		expect(sharedIdentityLabel(item, "sharedIn")).toEqual({ labelKey: "driveSharedByLabel", name: "sharer@filen.io" })
	})

	it("labels a resolvable identity on sharedOut with driveSharedWithLabel — who I shared it with", () => {
		const item = narrowItem(mockSharedFile())

		expect(sharedIdentityLabel(item, "sharedOut")).toEqual({ labelKey: "driveSharedWithLabel", name: "sharer@filen.io" })
	})
})
