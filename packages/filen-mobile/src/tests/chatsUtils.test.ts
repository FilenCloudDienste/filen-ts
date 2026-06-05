import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks (top-level, hoisted by Vitest) ───────────────────────

// utils.ts imports AnyFile (runtime class) + MaybeEncryptedUniffi_Tags (runtime enum) from
// @filen/sdk-rs. AnyFile.Linked just needs to capture its file arg so getFileUrl can be asserted.
vi.mock("@filen/sdk-rs", () => {
	class Linked {
		public readonly inner: unknown

		public constructor(file: unknown) {
			this.inner = file
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
import { resolveLinkMedia, type SuccessfulLink } from "@/features/chats/utils"

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

const getFileUrl = vi.fn((file: unknown) => `http://localhost/serve/${(file as { inner: { uuid: string } }).inner.uuid}`)

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
