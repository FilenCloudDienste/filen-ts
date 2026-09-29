import { Buffer } from "buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LinkedFile, DirPublicInfo } from "@filen/sdk-rs"

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { getLinkedFileAnon, getDirPublicLinkInfoAnon } = vi.hoisted(() => ({
	getLinkedFileAnon: vi.fn<(linkUuid: string, fileKey: string) => Promise<LinkedFile>>(),
	getDirPublicLinkInfoAnon: vi.fn<(linkUuid: string, linkKey: string) => Promise<DirPublicInfo>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getLinkedFileAnon, getDirPublicLinkInfoAnon } }))

import { fetchChatMessageLinks } from "@/features/chats/queries/chatMessageLinks"

// Version 4 (third group starts "4"), variant 8 (fourth "8") — parseFilenPublicLink validates both
// nibbles via the 'uuid' package, unlike a plain 8-4-4-4-12 hex-shape regex.
const UUID = "11111111-1111-4111-8111-111111111111"
// A realistic 32-byte key — @filen/shared's parseFilenPublicLink hard-rejects any other length.
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const KEY_HEX = Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")
const FILE_LINK_URL = `https://app.filen.io/#/d/${UUID}%23${KEY_HEX}`
const DIR_LINK_URL = `https://app.filen.io/#/f/${UUID}%23${KEY_HEX}`

function mockLinkedFile(overrides: Partial<LinkedFile> = {}): LinkedFile {
	return {
		uuid: UUID,
		name: { Decrypted: "photo.jpg" },
		mime: { Decrypted: "image/jpeg" },
		size: 1024n,
		chunks: 1n,
		region: "region",
		bucket: "bucket",
		version: 2,
		timestamp: 0n,
		fileKey: KEY_PLAINTEXT,
		downloadable: true,
		linkedTag: true,
		canMakeThumbnail: false,
		...overrides
	}
}

function mockDirPublicInfo(name: string | null, overrides: { timestamp?: bigint; created?: bigint } = {}): DirPublicInfo {
	const timestamp = overrides.timestamp ?? 0n

	return {
		root: {
			inner: {
				uuid: UUID,
				color: "default",
				timestamp,
				meta:
					name === null
						? { type: "encrypted", data: "cipher" }
						: { type: "decoded", data: { name, ...(overrides.created !== undefined ? { created: overrides.created } : {}) } }
			},
			linkedTag: true
		},
		link: {
			linkUuid: UUID,
			linkKey: KEY_PLAINTEXT,
			linkKeyVersion: 1,
			password: { type: "none" },
			enableDownload: true,
			salt: ""
		},
		hasPassword: false
	}
}

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("fetchChatMessageLinks — Filen file links", () => {
	it("resolves a file link's decrypted name + size + previewCategory + the raw LinkedFile on success", async () => {
		const linkedFile = mockLinkedFile({ name: { Decrypted: "vacation.jpg" }, mime: { Decrypted: "image/jpeg" }, size: 2048n })
		getLinkedFileAnon.mockResolvedValueOnce(linkedFile)

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(getLinkedFileAnon).toHaveBeenCalledExactlyOnceWith(UUID, KEY_PLAINTEXT)
		expect(results).toEqual([
			{
				url: FILE_LINK_URL,
				kind: "filenLink",
				link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT },
				success: true,
				data: { type: "file", name: "vacation.jpg", size: 2048n, previewCategory: "image", linkedFile }
			}
		])
	})

	it("resolves previewCategory from the extension, not just the mime — a .pdf-named file classifies as pdf", async () => {
		getLinkedFileAnon.mockResolvedValueOnce(
			mockLinkedFile({ name: { Decrypted: "invoice.pdf" }, mime: { Decrypted: "application/pdf" } })
		)

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { previewCategory: "pdf" } })
	})

	it("degrades to success:false (never throws) when getLinkedFileAnon rejects — e.g. a password-protected link", async () => {
		getLinkedFileAnon.mockRejectedValueOnce(new Error("password required"))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results).toEqual([
			{ url: FILE_LINK_URL, kind: "filenLink", link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false }
		])
	})

	it("degrades to name:null when the file's own name arrives still-Encrypted — never throws", async () => {
		getLinkedFileAnon.mockResolvedValueOnce(mockLinkedFile({ name: { Encrypted: "cipher" } }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { type: "file", name: null } })
	})

	it("still resolves previewCategory from the decrypted MIME when the name alone is undecryptable (extension-first, mime-fallback)", async () => {
		getLinkedFileAnon.mockResolvedValueOnce(mockLinkedFile({ name: { Encrypted: "cipher" }, mime: { Decrypted: "application/pdf" } }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { previewCategory: "pdf" } })
	})

	it("previewCategory falls back to 'other' when BOTH name and mime arrive still-Encrypted — no classification signal at all", async () => {
		getLinkedFileAnon.mockResolvedValueOnce(mockLinkedFile({ name: { Encrypted: "cipher-name" }, mime: { Encrypted: "cipher-mime" } }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { previewCategory: "other" } })
	})
})

describe("fetchChatMessageLinks — Filen directory links", () => {
	it("resolves a directory link's decoded name + created timestamp on success", async () => {
		getDirPublicLinkInfoAnon.mockResolvedValueOnce(mockDirPublicInfo("Shared Folder", { created: 1_650_000_000_000n }))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(getDirPublicLinkInfoAnon).toHaveBeenCalledExactlyOnceWith(UUID, KEY_PLAINTEXT)
		expect(results).toEqual([
			{
				url: DIR_LINK_URL,
				kind: "filenLink",
				link: { kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT },
				success: true,
				data: { type: "directory", name: "Shared Folder", timestamp: 1_650_000_000_000n }
			}
		])
	})

	it("falls back to the root's own raw timestamp when the decoded meta carries no `created`", async () => {
		getDirPublicLinkInfoAnon.mockResolvedValueOnce(mockDirPublicInfo("Shared Folder", { timestamp: 1_600_000_000_000n }))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { timestamp: 1_600_000_000_000n } })
	})

	it("degrades to name:null when the root dir's meta isn't decoded", async () => {
		getDirPublicLinkInfoAnon.mockResolvedValueOnce(mockDirPublicInfo(null))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { type: "directory", name: null } })
	})

	it("degrades to success:false on rejection", async () => {
		getDirPublicLinkInfoAnon.mockRejectedValueOnce(new Error("not found"))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(results).toEqual([
			{ url: DIR_LINK_URL, kind: "filenLink", link: { kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false }
		])
	})
})

describe("fetchChatMessageLinks — classification passthrough", () => {
	it("returns [] for a message with no in-scope links, and never fetches a remote image or video url", async () => {
		const fetchSpy = vi.fn()
		vi.stubGlobal("fetch", fetchSpy)

		const results = await fetchChatMessageLinks([
			"https://youtube.com/watch?v=x",
			"https://example.com/photo.jpg",
			"https://example.com/clip.mp4"
		])

		expect(results).toEqual([])
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(getLinkedFileAnon).not.toHaveBeenCalled()
		expect(getDirPublicLinkInfoAnon).not.toHaveBeenCalled()
	})

	it("resolves multiple distinct links independently (one rejection doesn't affect the others)", async () => {
		getLinkedFileAnon.mockRejectedValueOnce(new Error("fail"))
		getDirPublicLinkInfoAnon.mockResolvedValueOnce(mockDirPublicInfo("Shared Folder", { timestamp: 1n }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL, "https://example.com/photo.jpg", DIR_LINK_URL])

		expect(results).toEqual([
			{ url: FILE_LINK_URL, kind: "filenLink", link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false },
			{
				url: DIR_LINK_URL,
				kind: "filenLink",
				link: { kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT },
				success: true,
				data: { type: "directory", name: "Shared Folder", timestamp: 1n }
			}
		])
	})
})
