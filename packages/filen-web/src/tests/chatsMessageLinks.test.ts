import { Buffer } from "buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LinkedFile, DirPublicInfo } from "@filen/sdk-rs"

// Mock boundary matching chatsQueries.test.ts: the real sdk client module imports a Vite `?worker`,
// unresolvable under node vitest.
const { getLinkedFile, getDirPublicLinkInfo } = vi.hoisted(() => ({
	getLinkedFile: vi.fn<(linkUuid: string, fileKey: string) => Promise<LinkedFile>>(),
	getDirPublicLinkInfo: vi.fn<(linkUuid: string, linkKey: string) => Promise<DirPublicInfo>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getLinkedFile, getDirPublicLinkInfo } }))

import { fetchChatMessageLinks } from "@/features/chats/queries/chatMessageLinks"

const UUID = "11111111-1111-1111-1111-111111111111"
const KEY_PLAINTEXT = "the-file-key"
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
		linkedTag: true,
		...overrides
	}
}

function mockDirPublicInfo(name: string | null): DirPublicInfo {
	return {
		root: {
			inner: {
				uuid: UUID,
				color: "default",
				timestamp: 0n,
				meta: name === null ? { type: "encrypted", data: "cipher" } : { type: "decoded", data: { name } }
			},
			linkedTag: true
		},
		link: {
			linkUuid: UUID,
			linkKey: KEY_PLAINTEXT,
			linkKeyVersion: 1,
			password: undefined,
			enableDownload: true,
			salt: ""
		},
		hasPassword: false
	}
}

function stubFetch(impl: () => Promise<unknown>): void {
	vi.stubGlobal("fetch", vi.fn(impl))
}

function fakeHeadResponse(contentType: string | null, ok = true): unknown {
	return { ok, headers: { get: (key: string) => (key === "content-type" ? contentType : null) } }
}

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("fetchChatMessageLinks — Filen file links", () => {
	it("resolves a file link's decrypted name + size on success", async () => {
		getLinkedFile.mockResolvedValueOnce(mockLinkedFile({ name: { Decrypted: "vacation.jpg" }, size: 2048n }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(getLinkedFile).toHaveBeenCalledExactlyOnceWith(UUID, KEY_PLAINTEXT)
		expect(results).toEqual([
			{
				url: FILE_LINK_URL,
				kind: "filenLink",
				link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT },
				success: true,
				data: { type: "file", name: "vacation.jpg", size: 2048n }
			}
		])
	})

	it("degrades to success:false (never throws) when getLinkedFile rejects — e.g. a password-protected link", async () => {
		getLinkedFile.mockRejectedValueOnce(new Error("password required"))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results).toEqual([
			{ url: FILE_LINK_URL, kind: "filenLink", link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false }
		])
	})

	it("degrades to name:null when the file's own name arrives still-Encrypted (undecryptable) — never throws", async () => {
		getLinkedFile.mockResolvedValueOnce(mockLinkedFile({ name: { Encrypted: "cipher" } }))

		const results = await fetchChatMessageLinks([FILE_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { type: "file", name: null } })
	})
})

describe("fetchChatMessageLinks — Filen directory links", () => {
	it("resolves a directory link's decoded name on success", async () => {
		getDirPublicLinkInfo.mockResolvedValueOnce(mockDirPublicInfo("Shared Folder"))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(getDirPublicLinkInfo).toHaveBeenCalledExactlyOnceWith(UUID, KEY_PLAINTEXT)
		expect(results).toEqual([
			{
				url: DIR_LINK_URL,
				kind: "filenLink",
				link: { kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT },
				success: true,
				data: { type: "directory", name: "Shared Folder" }
			}
		])
	})

	it("degrades to name:null when the root dir's meta isn't decoded", async () => {
		getDirPublicLinkInfo.mockResolvedValueOnce(mockDirPublicInfo(null))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(results[0]).toMatchObject({ success: true, data: { type: "directory", name: null } })
	})

	it("degrades to success:false on rejection", async () => {
		getDirPublicLinkInfo.mockRejectedValueOnce(new Error("not found"))

		const results = await fetchChatMessageLinks([DIR_LINK_URL])

		expect(results).toEqual([
			{ url: DIR_LINK_URL, kind: "filenLink", link: { kind: "directory", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false }
		])
	})
})

describe("fetchChatMessageLinks — direct media probe (browser CORS-gated HEAD)", () => {
	const IMAGE_URL = "https://example.com/photo.jpg"

	it("succeeds when the HEAD probe returns a matching, allowlisted content-type", async () => {
		stubFetch(() => Promise.resolve(fakeHeadResponse("image/jpeg")))

		const results = await fetchChatMessageLinks([IMAGE_URL])

		expect(results).toEqual([{ url: IMAGE_URL, kind: "media", category: "image", success: true, contentType: "image/jpeg" }])
	})

	it("degrades to success:false when the content-type doesn't match the url's own extension category", async () => {
		// e.g. an .jpg url actually serving an html error/login page — never rendered as an image.
		stubFetch(() => Promise.resolve(fakeHeadResponse("text/html")))

		const results = await fetchChatMessageLinks([IMAGE_URL])

		expect(results).toEqual([{ url: IMAGE_URL, kind: "media", category: "image", success: false }])
	})

	it("degrades to success:false on a non-ok response", async () => {
		stubFetch(() => Promise.resolve(fakeHeadResponse("image/jpeg", false)))

		const results = await fetchChatMessageLinks([IMAGE_URL])

		expect(results).toEqual([{ url: IMAGE_URL, kind: "media", category: "image", success: false }])
	})

	it("degrades to success:false when fetch itself rejects — the common real-world case (no CORS headers on the target)", async () => {
		stubFetch(() => Promise.reject(new Error("CORS blocked")))

		const results = await fetchChatMessageLinks([IMAGE_URL])

		expect(results).toEqual([{ url: IMAGE_URL, kind: "media", category: "image", success: false }])
	})
})

describe("fetchChatMessageLinks — classification passthrough", () => {
	it("returns [] for a message with no in-scope links (D2 out-of-scope urls never reach the network)", async () => {
		const results = await fetchChatMessageLinks(["https://youtube.com/watch?v=x"])

		expect(results).toEqual([])
		expect(getLinkedFile).not.toHaveBeenCalled()
		expect(getDirPublicLinkInfo).not.toHaveBeenCalled()
	})

	it("resolves multiple distinct links independently (one rejection doesn't affect the others)", async () => {
		stubFetch(() => Promise.resolve(fakeHeadResponse("image/jpeg")))
		getLinkedFile.mockRejectedValueOnce(new Error("fail"))

		const results = await fetchChatMessageLinks([FILE_LINK_URL, "https://example.com/photo.jpg"])

		expect(results).toEqual([
			{ url: FILE_LINK_URL, kind: "filenLink", link: { kind: "file", linkUuid: UUID, key: KEY_PLAINTEXT }, success: false },
			{ url: "https://example.com/photo.jpg", kind: "media", category: "image", success: true, contentType: "image/jpeg" }
		])
	})
})
