import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks (top-level, hoisted by Vitest) ───────────────────────

// utils.ts imports AnyFile (runtime class) + MaybeEncryptedUniffi_Tags (runtime enum) from
// @filen/sdk-rs. AnyFile.Linked mirrors the real SDK shape: inner is a frozen 1-tuple [LinkedFile]
// (see sdk-rs generated/filen_sdk_rs.ts — constructor does `this.inner = Object.freeze([v0])`).
// Keeping the tuple shape means a future SDK change to the accessor would surface here.
vi.mock("@filen/sdk-rs", () => {
	class Linked {
		public readonly inner: Readonly<[unknown]>

		public constructor(file: unknown) {
			this.inner = Object.freeze([file]) as Readonly<[unknown]>
		}
	}

	return {
		AnyFile: { Linked },
		MaybeEncryptedUniffi_Tags: { Decrypted: 1, Encrypted: 0 }
	}
})

// The rest are only needed so utils.ts (which also exports the effectful openAttachmentPreview)
// loads cleanly in the node env — resolveLinkMedia itself touches none of them.
vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	linkedFileIntoDriveItem: vi.fn()
}))
vi.mock("@/stores/useDrivePreview.store", () => ({
	default: { getState: vi.fn(() => ({ open: vi.fn() })) }
}))
vi.mock("@/lib/alerts", () => ({ default: { normal: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k }, t: (k: string) => k }))

// ─── Actual imports ─────────────────────────────────────────────────────────────

import { MaybeEncryptedUniffi_Tags } from "@filen/sdk-rs"
import { resolveLinkMedia, resolveReplySenderDisplayName, composeMessageList, type SuccessfulLink } from "@/features/chats/utils"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function externalLink(previewType: string, overrides: Record<string, unknown> = {}): SuccessfulLink {
	return {
		type: "external",
		success: true,
		data: {
			previewType,
			url: "https://example.com/file.bin",
			name: "file.bin",
			contentType: "application/octet-stream",
			size: 1,
			...overrides
		}
	} as unknown as SuccessfulLink
}

function internalFileLink(previewType: string, name: string | null): SuccessfulLink {
	return {
		type: "internal",
		success: true,
		data: {
			type: "file",
			previewType,
			linkUuid: "link-uuid",
			fileKey: "file-key",
			file: {
				uuid: "file-uuid",
				size: 10n,
				name:
					name === null
						? { tag: MaybeEncryptedUniffi_Tags.Encrypted, inner: [] }
						: { tag: MaybeEncryptedUniffi_Tags.Decrypted, inner: [name] }
			}
		}
	} as unknown as SuccessfulLink
}

function internalDirectoryLink(): SuccessfulLink {
	return {
		type: "internal",
		success: true,
		data: {
			type: "directory",
			info: {
				link: { linkUuid: "dir-link-uuid", linkKey: "dir-link-key" },
				root: { inner: { uuid: "root-uuid", timestamp: 0n, meta: { tag: MaybeEncryptedUniffi_Tags.Encrypted } } }
			}
		}
	} as unknown as SuccessfulLink
}

// Access inner[0] to match the real AnyFile.Linked tuple shape (inner: Readonly<[LinkedFile]>).
const getFileUrl = vi.fn((file: unknown) => `http://localhost/serve/${(file as { inner: [{ uuid: string }] }).inner[0].uuid}`)

// ─── resolveLinkMedia ────────────────────────────────────────────────────────────

describe("resolveLinkMedia", () => {
	describe("external links", () => {
		it("classifies an external image link as image with its url + name", () => {
			const media = resolveLinkMedia(externalLink("image"), getFileUrl)

			expect(media.type).toBe("image")
			expect(media.url).toBe("https://example.com/file.bin")
			expect(media.name).toBe("file.bin")
			// external links never carry internal `linked` data
			expect(media.linked).toBeNull()
		})

		it("classifies an external video link as video", () => {
			const media = resolveLinkMedia(externalLink("video"), getFileUrl)

			expect(media.type).toBe("video")
			expect(media.url).toBe("https://example.com/file.bin")
		})

		it("returns type null for a non-media external link (e.g. unknown preview type)", () => {
			const media = resolveLinkMedia(externalLink("unknown"), getFileUrl)

			expect(media.type).toBeNull()
			expect(media.url).toBeNull()
			expect(media.name).toBeNull()
			expect(media.linked).toBeNull()
		})
	})

	describe("internal file links", () => {
		it("classifies an internal image file as image, serving via getFileUrl + using decrypted name", () => {
			const link = internalFileLink("image", "photo.jpg")
			const media = resolveLinkMedia(link, getFileUrl)

			expect(media.type).toBe("image")
			expect(media.url).toBe("http://localhost/serve/file-uuid")
			expect(media.name).toBe("photo.jpg")
			// internal media exposes its underlying link data for in-app drive preview
			expect(media.linked).toBe((link as { data: unknown }).data)
		})

		it("classifies an internal video file as video", () => {
			const media = resolveLinkMedia(internalFileLink("video", "clip.mp4"), getFileUrl)

			expect(media.type).toBe("video")
			expect(media.url).toBe("http://localhost/serve/file-uuid")
			expect(media.name).toBe("clip.mp4")
		})

		it("falls back to the file uuid as name when the file name is not decrypted", () => {
			const media = resolveLinkMedia(internalFileLink("image", null), getFileUrl)

			expect(media.type).toBe("image")
			expect(media.name).toBe("file-uuid")
		})

		it("falls through to internal when getFileUrl is unavailable for an internal image", () => {
			const link = internalFileLink("image", "photo.jpg")
			const media = resolveLinkMedia(link, null)

			// no way to serve the bytes → it degrades to the generic internal attachment
			expect(media.type).toBe("internal")
			expect(media.url).toBeNull()
			expect(media.name).toBeNull()
			expect(media.linked).toBe((link as { data: unknown }).data)
		})

		it("classifies a non-previewable internal file (unknown) as internal", () => {
			const link = internalFileLink("unknown", "archive.zip")
			const media = resolveLinkMedia(link, getFileUrl)

			expect(media.type).toBe("internal")
			expect(media.linked).toBe((link as { data: unknown }).data)
		})
	})

	describe("internal directory links", () => {
		it("classifies an internal directory as internal", () => {
			const link = internalDirectoryLink()
			const media = resolveLinkMedia(link, getFileUrl)

			expect(media.type).toBe("internal")
			expect(media.url).toBeNull()
			expect(media.name).toBeNull()
			expect(media.linked).toBe((link as { data: unknown }).data)
		})
	})
})

// ─── resolveReplySenderDisplayName ──────────────────────────────────────────────

describe("resolveReplySenderDisplayName", () => {
	it("returns the nickName when it is non-empty", () => {
		expect(resolveReplySenderDisplayName("Alice", "alice@example.com", "Unknown")).toBe("Alice")
	})

	it("falls back to the email when nickName is empty string", () => {
		expect(resolveReplySenderDisplayName("", "alice@example.com", "Unknown")).toBe("alice@example.com")
	})

	it("falls back to the email when nickName is undefined", () => {
		expect(resolveReplySenderDisplayName(undefined, "alice@example.com", "Unknown")).toBe("alice@example.com")
	})

	it("falls back to the fallback string when both nickName and email are empty strings", () => {
		expect(resolveReplySenderDisplayName("", "", "Unknown")).toBe("Unknown")
	})

	it("falls back to the fallback string when both nickName and email are undefined", () => {
		expect(resolveReplySenderDisplayName(undefined, undefined, "Unknown")).toBe("Unknown")
	})

	it("prefers nickName over email even when both are non-empty", () => {
		expect(resolveReplySenderDisplayName("Bob", "bob@example.com", "Unknown")).toBe("Bob")
	})
})

// ─── composeMessageList (D4c) ───────────────────────────────────────────────────

// Server messages carry a server uuid and an empty inflightId; optimistic/inflight messages use
// their inflightId as inner.uuid (see input/index.tsx send()).
function serverMessage(uuid: string, sentTimestamp: number, inflightId = ""): ChatMessageWithInflightId {
	return {
		inflightId,
		chat: "chat-1",
		inner: { uuid, message: `server ${uuid}` },
		sentTimestamp: BigInt(sentTimestamp)
	} as unknown as ChatMessageWithInflightId
}

function inflightMessage(inflightId: string, sentTimestamp: number): ChatMessageWithInflightId {
	return {
		inflightId,
		chat: "chat-1",
		inner: { uuid: inflightId, message: `inflight ${inflightId}` },
		sentTimestamp: BigInt(sentTimestamp)
	} as unknown as ChatMessageWithInflightId
}

describe("composeMessageList", () => {
	it("keeps the pre-overlay behavior: dedupes query data and paginated pages by inner.uuid, newest first", () => {
		const shared = serverMessage("msg-2", 2000)
		const result = composeMessageList({
			queryMessages: [serverMessage("msg-1", 1000), shared],
			fetchedMessages: [serverMessage("msg-2", 2000), serverMessage("msg-0", 500)],
			inflightMessages: [],
			failedMessages: []
		})

		expect(result.map(m => m.inner.uuid)).toEqual(["msg-2", "msg-1", "msg-0"])
		// The query copy wins over the paginated copy of the same uuid.
		expect(result[0]).toBe(shared)
	})

	it("a pending bubble survives a refetch that replaced the query data (no optimistic copy in it)", () => {
		// The refetch replaced the cache wholesale with server truth — the optimistic copy is
		// gone from query data but still queued in the inflight store.
		const pending = inflightMessage("ifl-1", 3000)
		const result = composeMessageList({
			queryMessages: [serverMessage("msg-1", 1000), serverMessage("msg-2", 2000)],
			fetchedMessages: [],
			inflightMessages: [pending],
			failedMessages: []
		})

		expect(result).toHaveLength(3)
		expect(result.some(m => m.inflightId === "ifl-1")).toBe(true)
		// Newest message → first in the inverted list (correct chronological position).
		expect(result[0]).toBe(pending)
	})

	it("a failed send dropped from the queue stays visible via its error snapshot", () => {
		const failed = inflightMessage("ifl-failed", 4000)
		const result = composeMessageList({
			queryMessages: [serverMessage("msg-1", 1000)],
			fetchedMessages: [],
			inflightMessages: [],
			failedMessages: [failed]
		})

		expect(result).toHaveLength(2)
		expect(result[0]).toBe(failed)
	})

	it("does NOT duplicate a committed message still present in the queue (deduped by inflightId)", () => {
		// chats.sendMessage reconciled the optimistic copy into the cache under the server uuid
		// (keeping its inflightId) — the queue still briefly holds the optimistic twin.
		const committed = serverMessage("server-uuid-1", 3000, "ifl-1")
		const queuedTwin = inflightMessage("ifl-1", 3000)
		const result = composeMessageList({
			queryMessages: [committed],
			fetchedMessages: [],
			inflightMessages: [queuedTwin],
			failedMessages: []
		})

		expect(result).toHaveLength(1)
		expect(result[0]).toBe(committed)
	})

	it("does NOT duplicate a failed message present in both the queue and the error snapshots", () => {
		// A failed-but-not-yet-dropped message lives in the queue AND in the error state.
		const queued = inflightMessage("ifl-1", 3000)
		const result = composeMessageList({
			queryMessages: [],
			fetchedMessages: [],
			inflightMessages: [queued],
			failedMessages: [inflightMessage("ifl-1", 3000)]
		})

		expect(result).toHaveLength(1)
		// The queue copy wins (listed before the failed snapshots).
		expect(result[0]).toBe(queued)
	})

	it("slots multiple pending messages into chronological (sent) order among server messages", () => {
		const result = composeMessageList({
			queryMessages: [serverMessage("msg-1", 1000), serverMessage("msg-3", 3000)],
			fetchedMessages: [],
			inflightMessages: [inflightMessage("ifl-2", 2000), inflightMessage("ifl-4", 4000)],
			failedMessages: []
		})

		expect(result.map(m => Number(m.sentTimestamp))).toEqual([4000, 3000, 2000, 1000])
	})

	it("renders pending and failed messages even when the query data is empty", () => {
		const result = composeMessageList({
			queryMessages: [],
			fetchedMessages: [],
			inflightMessages: [inflightMessage("ifl-1", 1000)],
			failedMessages: [inflightMessage("ifl-2", 2000)]
		})

		expect(result.map(m => m.inflightId)).toEqual(["ifl-2", "ifl-1"])
	})
})
