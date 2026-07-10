import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { SW_DOWNLOAD_PREFIX, SW_MSG_REGISTER_PREVIEW } from "@/lib/sw/protocol"

// previewStreamUrl is the request half of the inline-preview seam (usePreviewStreamUrl.ts's own
// abort surface is just a `live` flag guarding a late setState — no cancellation message exists,
// see that hook's own doc comment — so there is nothing server-side here to pin an abort against).
// ensureSwClientReady/activeServiceWorker/sendToSw are saveDownload.ts's own exports, already pinned
// by saveDownload.test.ts's sw-branch suite; only the registration payload/URL shape unique to the
// preview route is re-verified here, not the SW handshake plumbing itself.

const { ensureSwClientReady, activeServiceWorker, sendToSw } = vi.hoisted(() => ({
	ensureSwClientReady: vi.fn(),
	activeServiceWorker: vi.fn(),
	sendToSw: vi.fn()
}))

vi.mock("@/features/drive/lib/saveDownload", () => ({ ensureSwClientReady, activeServiceWorker, sendToSw }))

function testFile(overrides: Partial<AnyFile> = {}): AnyFile {
	return {
		uuid: "file-uuid",
		meta: { type: "encrypted", data: "x" },
		parent: "parent-uuid",
		size: 4_096n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		...overrides
	} as AnyFile
}

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("previewStreamUrl", () => {
	it("registers the file against SW_MSG_REGISTER_PREVIEW and returns a SW_DOWNLOAD_PREFIX url", async () => {
		ensureSwClientReady.mockResolvedValue(undefined)
		const target = { fake: "sw-target" }
		activeServiceWorker.mockResolvedValue(target)
		sendToSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const file = testFile()
		const url = await previewStreamUrl(file, "clip.mp4", "video/mp4")

		expect(ensureSwClientReady).toHaveBeenCalledTimes(1)
		expect(url.startsWith(SW_DOWNLOAD_PREFIX)).toBe(true)
		expect(url).toBe(`${SW_DOWNLOAD_PREFIX}${url.slice(SW_DOWNLOAD_PREFIX.length)}`)

		expect(sendToSw).toHaveBeenCalledTimes(1)
		const [sentTarget, type, payload] = sendToSw.mock.calls[0] as [unknown, string, Record<string, unknown>]

		expect(sentTarget).toBe(target)
		expect(type).toBe(SW_MSG_REGISTER_PREVIEW)
		expect(payload).toMatchObject({ file, name: "clip.mp4", size: 4_096, contentType: "video/mp4" })
		expect(payload["id"]).toBe(url.slice(SW_DOWNLOAD_PREFIX.length))
	})

	it("mints a distinct id per call", async () => {
		ensureSwClientReady.mockResolvedValue(undefined)
		activeServiceWorker.mockResolvedValue({})
		sendToSw.mockResolvedValue(undefined)

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")
		const a = await previewStreamUrl(testFile(), "a.mp4", "video/mp4")
		const b = await previewStreamUrl(testFile(), "b.mp4", "video/mp4")

		expect(a).not.toBe(b)
	})

	it("propagates a registration failure — caller (usePreviewStreamUrl) maps it to a fallback state, not a toast", async () => {
		ensureSwClientReady.mockResolvedValue(undefined)
		activeServiceWorker.mockResolvedValue({})
		sendToSw.mockRejectedValue(new Error("no room in sw registry"))

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4")).rejects.toThrow("no room in sw registry")
	})

	it("propagates a failure to acquire an active service worker without ever calling sendToSw", async () => {
		ensureSwClientReady.mockResolvedValue(undefined)
		activeServiceWorker.mockRejectedValue(new Error("no active service worker"))

		const { previewStreamUrl } = await import("@/features/preview/lib/previewStream")

		await expect(previewStreamUrl(testFile(), "clip.mp4", "video/mp4")).rejects.toThrow("no active service worker")
		expect(sendToSw).not.toHaveBeenCalled()
	})
})

describe("isMediaStreamAvailable", () => {
	it("true once a service worker is controlling the tab", async () => {
		vi.stubGlobal("navigator", { serviceWorker: { controller: {} } })

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(true)
	})

	it("false when no service worker has claimed the page yet", async () => {
		vi.stubGlobal("navigator", { serviceWorker: { controller: null } })

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(false)
	})

	it("false under dev, where lib/sw/register.ts never registers a service worker at all", async () => {
		vi.stubGlobal("navigator", {})

		const { isMediaStreamAvailable } = await import("@/features/preview/lib/previewStream")

		expect(isMediaStreamAvailable()).toBe(false)
	})
})
