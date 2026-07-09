import { describe, expect, it } from "vitest"
import type { Dir, DirPublicLinkRW, File, FilePublicLink, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveItemLinkStatus } from "@/features/drive/queries/drive"
import { buildLinkUpdate, buildPublicLinkUrl, readLinkForm } from "@/features/drive/components/linkDialog.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring versionsDialog.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDirLink(overrides: Partial<DirPublicLinkRW> = {}): DirPublicLinkRW {
	return {
		linkUuid: testUuid("dir-link"),
		linkKey: "dir-link-key",
		linkKeyVersion: 1,
		password: { type: "none" },
		expiration: "never",
		enableDownload: true,
		salt: "dir-salt",
		...overrides
	}
}

function mockFileLink(overrides: Partial<FilePublicLink> = {}): FilePublicLink {
	return {
		linkUuid: testUuid("file-link"),
		password: { type: "none" },
		expiration: "never",
		downloadable: true,
		salt: "file-salt",
		...overrides
	}
}

function dirStatus(overrides: Partial<DirPublicLinkRW> = {}): DriveItemLinkStatus {
	return { type: "directory", status: mockDirLink(overrides) }
}

function fileStatus(overrides: Partial<FilePublicLink> = {}): DriveItemLinkStatus {
	return { type: "file", status: mockFileLink(overrides) }
}

// Local Dir/File fixtures mirror versionsDialog.test.ts / itemMenu.test.ts's own per-file
// convention: a plain Dir/File builder, narrowed into a DriveItem by a separate wrapper.
function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir-item"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file-item"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "filekey", version: 2 }
		},
		...overrides
	}
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

describe("readLinkForm", () => {
	it("dir link: maps enableDownload -> downloadEnabled", () => {
		expect(readLinkForm(mockDirLink({ enableDownload: true })).downloadEnabled).toBe(true)
		expect(readLinkForm(mockDirLink({ enableDownload: false })).downloadEnabled).toBe(false)
	})

	it("file link: maps downloadable -> downloadEnabled", () => {
		expect(readLinkForm(mockFileLink({ downloadable: true })).downloadEnabled).toBe(true)
		expect(readLinkForm(mockFileLink({ downloadable: false })).downloadEnabled).toBe(false)
	})

	it("passes expiration through unchanged", () => {
		expect(readLinkForm(mockDirLink({ expiration: "7d" })).expiration).toBe("7d")
		expect(readLinkForm(mockFileLink({ expiration: "30d" })).expiration).toBe("30d")
	})

	it("passwordSet is false for {type:'none'}", () => {
		expect(readLinkForm(mockDirLink({ password: { type: "none" } })).passwordSet).toBe(false)
	})

	it("passwordSet is true for a 'known' password", () => {
		expect(readLinkForm(mockFileLink({ password: { type: "known", data: "plaintext" } })).passwordSet).toBe(true)
	})

	it("passwordSet is true for a 'hashed' password (no plaintext available, still counts as set)", () => {
		expect(readLinkForm(mockDirLink({ password: { type: "hashed", data: "hashed-value" } })).passwordSet).toBe(true)
	})
})

describe("buildLinkUpdate — field-name asymmetry", () => {
	it("directory: downloadEnabled edit lands on enableDownload, not downloadable", () => {
		const current = dirStatus({ enableDownload: false })

		const next = buildLinkUpdate(current, { downloadEnabled: true })

		expect(next.type).toBe("directory")
		if (next.type === "directory") {
			expect(next.status.enableDownload).toBe(true)
			expect(next.status).not.toHaveProperty("downloadable")
		}
	})

	it("file: downloadEnabled edit lands on downloadable, not enableDownload", () => {
		const current = fileStatus({ downloadable: false })

		const next = buildLinkUpdate(current, { downloadEnabled: true })

		expect(next.type).toBe("file")
		if (next.type === "file") {
			expect(next.status.downloadable).toBe(true)
			expect(next.status).not.toHaveProperty("enableDownload")
		}
	})

	it("an omitted downloadEnabled edit leaves the current value untouched, per type", () => {
		const dirNext = buildLinkUpdate(dirStatus({ enableDownload: true }), {})
		const fileNext = buildLinkUpdate(fileStatus({ downloadable: false }), {})

		expect(dirNext.type === "directory" && dirNext.status.enableDownload).toBe(true)
		expect(fileNext.type === "file" && fileNext.status.downloadable).toBe(false)
	})
})

describe("buildLinkUpdate — password resolution", () => {
	it("untouched (edits.password omitted) resends the existing PasswordState verbatim, including 'hashed'", () => {
		const hashed = { type: "hashed", data: "existing-hash" } as const
		const current = dirStatus({ password: hashed })

		const next = buildLinkUpdate(current, { expiration: "1d" })

		expect(next.type === "directory" && next.status.password).toBe(hashed)
	})

	it("a new plaintext password resolves to a 'known' PasswordState carrying that plaintext", () => {
		const current = fileStatus({ password: { type: "none" } })

		const next = buildLinkUpdate(current, { password: { kind: "new", plaintext: "hunter2" } })

		if (next.type !== "file") {
			throw new Error("expected a file arm")
		}
		if (next.status.password.type !== "known") {
			throw new Error("expected a known password")
		}
		expect(next.status.password.data).toBe("hunter2")
	})

	it("clearing resolves to {type:'none'}, discarding whatever password existed before", () => {
		const hashed = { type: "hashed", data: "existing-hash" } as const
		const current = fileStatus({ password: hashed })

		const next = buildLinkUpdate(current, { password: { kind: "cleared" } })

		expect(next.type === "file" && next.status.password).toEqual({ type: "none" })
	})
})

describe("buildLinkUpdate — passthrough fields", () => {
	it("directory: linkUuid, linkKey, linkKeyVersion, and salt survive an unrelated edit", () => {
		const current = dirStatus({ linkUuid: testUuid("stable"), linkKey: "stable-key", linkKeyVersion: 3, salt: "stable-salt" })

		const next = buildLinkUpdate(current, { expiration: "6h" })

		expect(next.type === "directory" && next.status.linkUuid).toBe(testUuid("stable"))
		expect(next.type === "directory" && next.status.linkKey).toBe("stable-key")
		expect(next.type === "directory" && next.status.linkKeyVersion).toBe(3)
		expect(next.type === "directory" && next.status.salt).toBe("stable-salt")
	})

	it("directory: an undefined linkKey survives unchanged (genuinely optional, not defaulted)", () => {
		const current = dirStatus({ linkKey: undefined, linkKeyVersion: undefined })

		const next = buildLinkUpdate(current, { expiration: "6h" })

		expect(next.type === "directory" && next.status.linkKey).toBeUndefined()
		expect(next.type === "directory" && next.status.linkKeyVersion).toBeUndefined()
	})

	it("file: linkUuid and salt survive an unrelated edit", () => {
		const current = fileStatus({ linkUuid: testUuid("stable"), salt: "stable-salt" })

		const next = buildLinkUpdate(current, { expiration: "14d" })

		expect(next.type === "file" && next.status.linkUuid).toBe(testUuid("stable"))
		expect(next.type === "file" && next.status.salt).toBe("stable-salt")
	})

	it("expiration passes through unchanged when omitted, updates when supplied", () => {
		const current = dirStatus({ expiration: "never" })

		expect(buildLinkUpdate(current, {}).status.expiration).toBe("never")
		expect(buildLinkUpdate(current, { expiration: "3d" }).status.expiration).toBe("3d")
	})
})

describe("buildPublicLinkUrl", () => {
	it("file: uses the item's own decrypted metadata key (hex-encoded), the /d/ prefix, and the link's uuid", () => {
		const item = fileItem({
			meta: { type: "decoded", data: { name: "f", mime: "x", modified: 1n, size: 1n, key: "abc", version: 2 } }
		})
		const status = fileStatus({ linkUuid: testUuid("link") })

		const url = buildPublicLinkUrl(item, status)

		expect(url).toBe(`https://app.filen.io/#/d/${testUuid("link")}%23616263`)
	})

	it("directory: uses the link's own linkKey (hex-encoded), the /f/ prefix, and the link's uuid", () => {
		const item = dirItem()
		const status = dirStatus({ linkUuid: testUuid("link"), linkKey: "abc" })

		const url = buildPublicLinkUrl(item, status)

		expect(url).toBe(`https://app.filen.io/#/f/${testUuid("link")}%23616263`)
	})

	it("directory: returns null when the link has no linkKey yet", () => {
		const item = dirItem()
		const status = dirStatus({ linkKey: undefined })

		expect(buildPublicLinkUrl(item, status)).toBeNull()
	})

	it("file: returns null when the item is undecryptable (no metadata key available)", () => {
		const item = fileItem({ meta: { type: "encrypted", data: "ciphertext" } })
		const status = fileStatus()

		expect(buildPublicLinkUrl(item, status)).toBeNull()
	})

	it("returns null on an item/status type mismatch rather than reading a field that doesn't exist", () => {
		const item = dirItem()
		const mismatchedStatus = fileStatus()

		expect(buildPublicLinkUrl(item, mismatchedStatus)).toBeNull()
	})
})
