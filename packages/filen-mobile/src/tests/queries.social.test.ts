import { vi, describe, it, expect, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mock factories — must be declared before any vi.mock() calls
// ---------------------------------------------------------------------------

const {
	mockGetSdkClients,
	mockAuthedSdkClient,
	mockChatUuidToChat,
	mockNoteUuidToNote,
	mockParseFilenPublicLink
} = vi.hoisted(() => {
	const mockAuthedSdkClient = {
		getDirPublicLinkInfo: vi.fn(),
		getLinkedFile: vi.fn(),
		listMessagesBefore: vi.fn(),
		listNotes: vi.fn(),
		getNoteContent: vi.fn(),
		listNoteTags: vi.fn(),
		listChats: vi.fn()
	}

	// Plain Map — avoids the PersistentMap.assertReady() guard
	const mockChatUuidToChat = new Map<string, unknown>()
	const mockNoteUuidToNote = new Map<string, unknown>()

	return {
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockAuthedSdkClient }),
		mockAuthedSdkClient,
		mockChatUuidToChat,
		mockNoteUuidToNote,
		mockParseFilenPublicLink: vi.fn().mockReturnValue(null)
	}
})

// ---------------------------------------------------------------------------
// Module mocks — order matters: boundary mocks BEFORE real-module imports
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@filen/utils", async () => {
	const real = await import("@/tests/mocks/filenUtils")

	return {
		...real,
		parseFilenPublicLink: mockParseFilenPublicLink,
		sortParams: (p: unknown) => p
	}
})

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		chatUuidToChat: mockChatUuidToChat,
		noteUuidToNote: mockNoteUuidToNote
	}
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

// Mock @filen/sdk-rs before @/lib/utils so the SDK enum is available
vi.mock("@filen/sdk-rs", () => ({
	MaybeEncryptedUniffi_Tags: {
		Decrypted: "Decrypted",
		Encrypted: "Encrypted"
	}
}))

// ---------------------------------------------------------------------------
// @/lib/utils — provide pure re-implementations of safeParseUrl and
// getPreviewType so they exercise real logic without dragging in
// expo-localization (__DEV__ not defined in Vitest node env).
// ---------------------------------------------------------------------------
const PRIVATE_HOST_REGEXES = [
	/^localhost$/i,
	/\.local$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^169\.254\./,
	/^0\.0\.0\.0$/,
	/^::1$/,
	/^fc00:/i,
	/^fe80:/i
]

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".svg", ".ico"])
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".3gp"])
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".aiff", ".caf", ".flac", ".alac"])

function safeParseUrlInline(raw: string): URL | null {
	try {
		const u = new URL(raw.trim())

		if (u.protocol !== "https:") return null
		if (u.username || u.password) return null
		if (PRIVATE_HOST_REGEXES.some(p => p.test(u.hostname))) return null

		return u
	} catch {
		return null
	}
}

function getExtname(name: string): string {
	const trimmed = name.trim().toLowerCase()
	const dot = trimmed.lastIndexOf(".")

	return dot === -1 ? "" : trimmed.slice(dot)
}

function getPreviewTypeInline(name: string): string {
	const ext = getExtname(name)

	if (IMAGE_EXTS.has(ext)) return "image"
	if (VIDEO_EXTS.has(ext)) return "video"
	if (AUDIO_EXTS.has(ext)) return "audio"

	switch (ext) {
		case ".pdf":
			return "pdf"
		case ".txt":
			return "text"
		case ".docx":
			return "docx"
		default:
			return "unknown"
	}
}

vi.mock("@/lib/utils", () => ({
	safeParseUrl: safeParseUrlInline,
	getPreviewType: getPreviewTypeInline,
	extractLinks: vi.fn()
}))

// ---------------------------------------------------------------------------
// Imports under test (placed AFTER all vi.mock() calls)
// ---------------------------------------------------------------------------

import { probeMedia, fetchData as fetchChatMessageLinks } from "@/queries/useChatMessageLinks.query"
import { fetchData as fetchChatMessages } from "@/queries/useChatMessages.query"
import { fetchData as fetchNotesWithContent } from "@/queries/useNotesWithContent.query"
import { fetchData as fetchNotesTags } from "@/queries/useNotesTags.query"
import { fetchData as fetchChats } from "@/queries/useChats.query"

// ---------------------------------------------------------------------------
// Helper: build a minimal Response-like object
// ---------------------------------------------------------------------------

function makeResponse(opts: {
	url?: string
	ok?: boolean
	contentType?: string | null
	contentLength?: string | null
}): Response {
	const headers = new Map<string, string>()

	if (opts.contentType !== undefined && opts.contentType !== null) {
		headers.set("content-type", opts.contentType)
	}

	if (opts.contentLength !== undefined && opts.contentLength !== null) {
		headers.set("content-length", opts.contentLength)
	}

	return {
		ok: opts.ok ?? true,
		url: opts.url ?? "https://example.com/img.jpg",
		headers: {
			get: (key: string) => headers.get(key.toLowerCase()) ?? null
		},
		status: 200,
		statusText: "OK",
		redirected: false,
		type: "basic"
	} as unknown as Response
}

// ---------------------------------------------------------------------------
// probeMedia
// ---------------------------------------------------------------------------

describe("probeMedia", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("returns {success:false} for non-HTTPS URL (http://)", async () => {
		const result = await probeMedia("http://example.com/img.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} for an unparseable raw URL", async () => {
		const result = await probeMedia("not a url at all!!")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} when fetchMetadata returns null (both HEAD and GET fail)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")))

		const result = await probeMedia("https://example.com/img.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} when response URL fails safeParseUrl (private IP redirect — SSRF guard)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://192.168.1.1/malicious.jpg",
					contentType: "image/jpeg",
					contentLength: "1024"
				})
			)
		)

		const result = await probeMedia("https://example.com/safe")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} when content-length header is missing (lenHeader null)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/img.jpg",
					contentType: "image/jpeg",
					contentLength: null
				})
			)
		)

		const result = await probeMedia("https://example.com/img.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} when content-length is a non-numeric string (parseInt->NaN, !isFinite)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/img.jpg",
					contentType: "image/jpeg",
					contentLength: "banana"
				})
			)
		)

		const result = await probeMedia("https://example.com/img.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:false} for negative content-length", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/img.jpg",
					contentType: "image/jpeg",
					contentLength: "-1"
				})
			)
		)

		const result = await probeMedia("https://example.com/img.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:true, size:0} for image with zero content-length", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/img.jpg",
					contentType: "image/jpeg",
					contentLength: "0"
				})
			)
		)

		const result = await probeMedia("https://example.com/img.jpg")

		expect(result.success).toBe(true)

		if (result.success) {
			expect(result.size).toBe(0)
		}
	})

	it("returns {success:false} for image with size > 32 MiB (33554433 bytes)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/big.jpg",
					contentType: "image/jpeg",
					contentLength: "33554433"
				})
			)
		)

		const result = await probeMedia("https://example.com/big.jpg")

		expect(result.success).toBe(false)
	})

	it("returns {success:true} for image with size exactly 32 MiB — inclusive boundary (33554432 bytes)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/exact.jpg",
					contentType: "image/jpeg",
					contentLength: "33554432"
				})
			)
		)

		const result = await probeMedia("https://example.com/exact.jpg")

		expect(result.success).toBe(true)

		if (result.success) {
			expect(result.size).toBe(33554432)
		}
	})

	it("returns {success:false} for image with size exactly 32 MiB + 1 (33554433 bytes)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/over.jpg",
					contentType: "image/jpeg",
					contentLength: String(32 * 1024 * 1024 + 1)
				})
			)
		)

		const result = await probeMedia("https://example.com/over.jpg")

		expect(result.success).toBe(false)
	})

	it("reports previewType 'video' for video/mp4 content-type", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/clip.mp4",
					contentType: "video/mp4",
					contentLength: "1024"
				})
			)
		)

		const result = await probeMedia("https://example.com/clip.mp4")

		expect(result.success).toBe(true)

		if (result.success) {
			expect(result.previewType).toBe("video")
		}
	})

	it("reports previewType 'audio' for audio/mp4 content-type (maps to .m4a extension)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/song.m4a",
					contentType: "audio/mp4",
					contentLength: "1024"
				})
			)
		)

		const result = await probeMedia("https://example.com/song.m4a")

		expect(result.success).toBe(true)

		if (result.success) {
			// mime-types maps audio/mp4 -> m4a, which is in the AUDIO_EXTS set
			expect(result.previewType).toBe("audio")
		}
	})

	it("strips charset suffix: 'image/jpeg; charset=utf-8' becomes contentType 'image/jpeg'", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/photo.jpg",
					contentType: "image/jpeg; charset=utf-8",
					contentLength: "512"
				})
			)
		)

		const result = await probeMedia("https://example.com/photo.jpg")

		expect(result.success).toBe(true)

		if (result.success) {
			expect(result.contentType).toBe("image/jpeg")
		}
	})

	it("returns {success:false} for empty content-type string", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/unknown",
					contentType: "",
					contentLength: "128"
				})
			)
		)

		const result = await probeMedia("https://example.com/unknown")

		expect(result.success).toBe(false)
	})

	it("derives name from pathname stem + mime extension: /img.png with image/jpeg -> 'img.jpeg' (or 'img.jpg')", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/img.png",
					contentType: "image/jpeg",
					contentLength: "256"
				})
			)
		)

		const result = await probeMedia("https://example.com/img.png")

		expect(result.success).toBe(true)

		if (result.success) {
			// stem is "img", mime-types maps image/jpeg to "jpeg"
			expect(result.name).toMatch(/^img\.(jpeg|jpg)$/)
		}
	})

	it("returns {success:false} when AbortSignal is fired before call resolves", async () => {
		const ctrl = new AbortController()

		ctrl.abort()

		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")))

		const result = await probeMedia("https://example.com/img.jpg", ctrl.signal)

		expect(result.success).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// fetchData — useChatMessageLinks
// ---------------------------------------------------------------------------

describe("fetchData (useChatMessageLinks)", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		mockParseFilenPublicLink.mockReturnValue(null)
		mockAuthedSdkClient.getDirPublicLinkInfo.mockReset()
		mockAuthedSdkClient.getLinkedFile.mockReset()
	})

	it("returns [] immediately for empty links array without calling getSdkClients", async () => {
		const result = await fetchChatMessageLinks({ links: [] })

		expect(result).toEqual([])
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns {type:'external', success:false} (fulfilled) when probeMedia fails — not a rejected promise", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network dead")))

		mockParseFilenPublicLink.mockReturnValue(null)

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://example.com/img.jpg", start: 0, end: 30 }]
		})

		// Promise.allSettled: the link resolves to {success:false} (not throws), so it's fulfilled
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ type: "external", success: false })
	})

	it("returns {type:'external', success:true} when probeMedia succeeds for external link", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				makeResponse({
					url: "https://example.com/photo.jpg",
					contentType: "image/jpeg",
					contentLength: "1024"
				})
			)
		)

		mockParseFilenPublicLink.mockReturnValue(null)

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://example.com/photo.jpg", start: 0, end: 35 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ type: "external", success: true })
	})

	it("returns {type:'internal', success:true, data:{type:'directory'}} for filen directory public link", async () => {
		const dirInfo = { uuid: "dir-uuid", name: "My Directory" }

		mockParseFilenPublicLink.mockReturnValue({ type: "directory", uuid: "dir-uuid", key: "dir-key" })

		mockAuthedSdkClient.getDirPublicLinkInfo.mockResolvedValue(dirInfo)

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://app.filen.io/#/f/dir-uuid#dir-key", start: 0, end: 40 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			type: "internal",
			success: true,
			data: { type: "directory", info: dirInfo }
		})
	})

	it("returns {type:'internal', success:false} when getDirPublicLinkInfo fails", async () => {
		mockParseFilenPublicLink.mockReturnValue({ type: "directory", uuid: "dir-uuid", key: "dir-key" })

		mockAuthedSdkClient.getDirPublicLinkInfo.mockRejectedValue(new Error("not found"))

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://app.filen.io/#/f/dir-uuid#dir-key", start: 0, end: 40 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ type: "internal", success: false })
	})

	it("returns {type:'internal', success:false} when file name tag is not Decrypted", async () => {
		mockParseFilenPublicLink.mockReturnValue({ type: "file", uuid: "file-uuid", key: "file-key" })

		mockAuthedSdkClient.getLinkedFile.mockResolvedValue({
			uuid: "file-uuid",
			size: 1024n,
			name: { tag: "Encrypted", inner: ["encrypted-blob"] }
		})

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://app.filen.io/#/d/file-uuid#file-key", start: 0, end: 40 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ type: "internal", success: false })
	})

	it("returns {type:'internal', success:false} for filen image file with Decrypted name and size > 32 MiB", async () => {
		mockParseFilenPublicLink.mockReturnValue({ type: "file", uuid: "file-uuid", key: "file-key" })

		mockAuthedSdkClient.getLinkedFile.mockResolvedValue({
			uuid: "file-uuid",
			size: BigInt(32 * 1024 * 1024 + 1),
			name: { tag: "Decrypted", inner: ["big-image.jpg"] }
		})

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://app.filen.io/#/d/file-uuid#file-key", start: 0, end: 40 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ type: "internal", success: false })
	})

	it("returns {type:'internal', success:true} for filen file with Decrypted name and size <= 32 MiB", async () => {
		mockParseFilenPublicLink.mockReturnValue({ type: "file", uuid: "file-uuid", key: "file-key" })

		mockAuthedSdkClient.getLinkedFile.mockResolvedValue({
			uuid: "file-uuid",
			size: BigInt(1024),
			name: { tag: "Decrypted", inner: ["photo.jpg"] },
			fileKey: "file-key"
		})

		const result = await fetchChatMessageLinks({
			links: [{ url: "https://app.filen.io/#/d/file-uuid#file-key", start: 0, end: 40 }]
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			type: "internal",
			success: true,
			data: { type: "file", linkUuid: "file-uuid", fileKey: "file-key" }
		})
	})
})

// ---------------------------------------------------------------------------
// fetchData — useChatMessages
// ---------------------------------------------------------------------------

describe("fetchData (useChatMessages)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockAuthedSdkClient.listMessagesBefore.mockReset()
		mockChatUuidToChat.clear()
	})

	it("returns [] when chatUuidToChat has no entry for the uuid (cache miss)", async () => {
		const result = await fetchChatMessages({ uuid: "nonexistent-chat" })

		expect(result).toEqual([])
		expect(mockAuthedSdkClient.listMessagesBefore).not.toHaveBeenCalled()
	})

	it("sets undecryptable:false when inner.message is a defined string", async () => {
		mockChatUuidToChat.set("chat-abc", { uuid: "chat-abc", key: "key-abc" })

		mockAuthedSdkClient.listMessagesBefore.mockResolvedValue([
			{
				chat: "chat-abc",
				inner: { uuid: "msg-1", message: "Hello world", senderId: 1n, senderEmail: "a@b.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			}
		])

		const result = await fetchChatMessages({ uuid: "chat-abc" })

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: false })
	})

	it("sets undecryptable:true when inner.message is undefined", async () => {
		mockChatUuidToChat.set("chat-abc", { uuid: "chat-abc", key: "key-abc" })

		mockAuthedSdkClient.listMessagesBefore.mockResolvedValue([
			{
				chat: "chat-abc",
				inner: { uuid: "msg-enc", message: undefined, senderId: 1n, senderEmail: "a@b.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			}
		])

		const result = await fetchChatMessages({ uuid: "chat-abc" })

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: true })
	})

	it("always sets inflightId to '' (empty string) for every fetched message", async () => {
		mockChatUuidToChat.set("chat-abc", { uuid: "chat-abc", key: "key-abc" })

		mockAuthedSdkClient.listMessagesBefore.mockResolvedValue([
			{
				chat: "chat-abc",
				inner: { uuid: "msg-1", message: "Hi", senderId: 1n, senderEmail: "a@b.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			},
			{
				chat: "chat-abc",
				inner: { uuid: "msg-2", message: undefined, senderId: 2n, senderEmail: "b@b.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			}
		])

		const result = await fetchChatMessages({ uuid: "chat-abc" })

		expect(result).toHaveLength(2)
		expect(result[0]?.inflightId).toBe("")
		expect(result[1]?.inflightId).toBe("")
	})

	it("returns all messages when a cache hit is present", async () => {
		mockChatUuidToChat.set("chat-xyz", { uuid: "chat-xyz", key: "key-xyz" })

		mockAuthedSdkClient.listMessagesBefore.mockResolvedValue([
			{
				chat: "chat-xyz",
				inner: { uuid: "m1", message: "a", senderId: 1n, senderEmail: "x@x.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			},
			{
				chat: "chat-xyz",
				inner: { uuid: "m2", message: "b", senderId: 1n, senderEmail: "x@x.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 1n,
				sentTimestamp: 1n,
				replyTo: undefined
			}
		])

		const result = await fetchChatMessages({ uuid: "chat-xyz" })

		expect(result).toHaveLength(2)
	})
})

// ---------------------------------------------------------------------------
// fetchData — useNotesWithContent
// ---------------------------------------------------------------------------

describe("fetchData (useNotesWithContent)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockAuthedSdkClient.listNotes.mockReset()
		mockAuthedSdkClient.getNoteContent.mockReset()
		mockNoteUuidToNote.clear()
	})

	it("sets undecryptable:true and content:'' without calling getNoteContent when encryptionKey is undefined", async () => {
		mockAuthedSdkClient.listNotes.mockResolvedValue([
			{
				uuid: "note-enc",
				encryptionKey: undefined,
				title: undefined,
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: []
			}
		])

		const result = await fetchNotesWithContent()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: true, content: "" })
		expect(mockAuthedSdkClient.getNoteContent).not.toHaveBeenCalled()
	})

	it("sets undecryptable:false and calls getNoteContent when encryptionKey is defined", async () => {
		mockAuthedSdkClient.listNotes.mockResolvedValue([
			{
				uuid: "note-ok",
				encryptionKey: "some-key",
				title: "Test Note",
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: []
			}
		])

		mockAuthedSdkClient.getNoteContent.mockResolvedValue("Note body text")

		const result = await fetchNotesWithContent()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: false, content: "Note body text" })
		expect(mockAuthedSdkClient.getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("falls back to '' when getNoteContent returns null", async () => {
		mockAuthedSdkClient.listNotes.mockResolvedValue([
			{
				uuid: "note-null",
				encryptionKey: "key-exists",
				title: "Nullable",
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: []
			}
		])

		mockAuthedSdkClient.getNoteContent.mockResolvedValue(null)

		const result = await fetchNotesWithContent()

		expect(result).toHaveLength(1)
		expect(result[0]?.content).toBe("")
	})

	it("populates cache.noteUuidToNote for every note in the batch", async () => {
		mockAuthedSdkClient.listNotes.mockResolvedValue([
			{
				uuid: "note-a",
				encryptionKey: "k-a",
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: [],
				title: "A"
			},
			{
				uuid: "note-b",
				encryptionKey: undefined,
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: [],
				title: undefined
			}
		])

		mockAuthedSdkClient.getNoteContent.mockResolvedValue("content a")

		await fetchNotesWithContent()

		expect(mockNoteUuidToNote.has("note-a")).toBe(true)
		expect(mockNoteUuidToNote.has("note-b")).toBe(true)
	})

	it("handles mixed decryptable/undecryptable notes in one batch — correct flags on each", async () => {
		mockAuthedSdkClient.listNotes.mockResolvedValue([
			{
				uuid: "decryptable",
				encryptionKey: "has-key",
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: [],
				title: "D"
			},
			{
				uuid: "undecryptable",
				encryptionKey: undefined,
				noteType: "text",
				pinned: false,
				favorite: false,
				archive: false,
				trash: false,
				tags: [],
				ownerId: 1n,
				lastEditorId: 1n,
				createdTimestamp: 0n,
				editedTimestamp: 0n,
				participants: [],
				title: undefined
			}
		])

		mockAuthedSdkClient.getNoteContent.mockResolvedValue("body")

		const result = await fetchNotesWithContent()

		const d = result.find(n => n.uuid === "decryptable")
		const u = result.find(n => n.uuid === "undecryptable")

		expect(d?.undecryptable).toBe(false)
		expect(d?.content).toBe("body")
		expect(u?.undecryptable).toBe(true)
		expect(u?.content).toBe("")
	})
})

// ---------------------------------------------------------------------------
// fetchData — useNotesTags
// ---------------------------------------------------------------------------

describe("fetchData (useNotesTags)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockAuthedSdkClient.listNoteTags.mockReset()
	})

	it("returns [] for empty tag list", async () => {
		mockAuthedSdkClient.listNoteTags.mockResolvedValue([])

		const result = await fetchNotesTags()

		expect(result).toEqual([])
	})

	it("sets undecryptable:false when tag.name is a defined string", async () => {
		mockAuthedSdkClient.listNoteTags.mockResolvedValue([
			{ uuid: "tag-1", name: "work", favorite: false, editedTimestamp: 0n, createdTimestamp: 0n }
		])

		const result = await fetchNotesTags()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: false, name: "work", uuid: "tag-1" })
	})

	it("sets undecryptable:true when tag.name is undefined", async () => {
		mockAuthedSdkClient.listNoteTags.mockResolvedValue([
			{ uuid: "tag-enc", name: undefined, favorite: false, editedTimestamp: 0n, createdTimestamp: 0n }
		])

		const result = await fetchNotesTags()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: true })
	})

	it("spreads all SDK tag properties into the result object", async () => {
		const sdkTag = { uuid: "tag-full", name: "personal", favorite: true, editedTimestamp: 9999n, createdTimestamp: 1234n }

		mockAuthedSdkClient.listNoteTags.mockResolvedValue([sdkTag])

		const result = await fetchNotesTags()

		expect(result[0]).toMatchObject({
			uuid: "tag-full",
			name: "personal",
			favorite: true,
			editedTimestamp: 9999n,
			createdTimestamp: 1234n,
			undecryptable: false
		})
	})
})

// ---------------------------------------------------------------------------
// fetchData — useChats
// ---------------------------------------------------------------------------

describe("fetchData (useChats)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockAuthedSdkClient.listChats.mockReset()
		mockChatUuidToChat.clear()
	})

	it("returns [] for empty chat list", async () => {
		mockAuthedSdkClient.listChats.mockResolvedValue([])

		const result = await fetchChats()

		expect(result).toEqual([])
	})

	it("sets undecryptable:false when chat.key is defined", async () => {
		mockAuthedSdkClient.listChats.mockResolvedValue([
			{ uuid: "chat-1", key: "some-key", ownerId: 1n, muted: false, participants: [], created: 0n, lastFocus: 0n }
		])

		const result = await fetchChats()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: false, uuid: "chat-1" })
	})

	it("sets undecryptable:true when chat.key is undefined", async () => {
		mockAuthedSdkClient.listChats.mockResolvedValue([
			{ uuid: "chat-enc", key: undefined, ownerId: 1n, muted: false, participants: [], created: 0n, lastFocus: 0n }
		])

		const result = await fetchChats()

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ undecryptable: true })
	})

	it("inserts all returned chats into cache.chatUuidToChat (both decryptable and undecryptable)", async () => {
		mockAuthedSdkClient.listChats.mockResolvedValue([
			{ uuid: "c-a", key: "k-a", ownerId: 1n, muted: false, participants: [], created: 0n, lastFocus: 0n },
			{ uuid: "c-b", key: undefined, ownerId: 1n, muted: false, participants: [], created: 0n, lastFocus: 0n }
		])

		await fetchChats()

		expect(mockChatUuidToChat.has("c-a")).toBe(true)
		expect(mockChatUuidToChat.has("c-b")).toBe(true)
	})
})
