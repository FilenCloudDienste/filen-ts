// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { DeviceProfile } from "@/lib/deviceProfile"
import { testUuid } from "@/tests/support/uuid"

// Loading the slideshow's next image ahead: only where its slot would show it from the same stream URL, and that
// stream released once the slot holds it.

const stream = vi.hoisted(() => ({
	available: true,
	hold: vi.fn<(id: string) => void>(),
	release: vi.fn<(id: string) => void>(),
	url: vi.fn((_file: unknown, _name: string, _contentType: string, id: string) => Promise.resolve(`/sw/preview/${id}`))
}))

vi.mock("@/features/preview/lib/previewStream", () => ({
	holdPreviewStream: stream.hold,
	releasePreviewStreamSoon: stream.release,
	previewStreamUrl: stream.url,
	isMediaStreamAvailable: () => stream.available
}))

const held = vi.hoisted(() => ({ bytes: new Set<string>() }))

vi.mock("@/features/preview/lib/previewCache", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/previewCache")>()

	return {
		...actual,
		getPreviewBytes: (_scope: string | null, uuid: string) => (held.bytes.has(uuid) ? new Uint8Array(1) : undefined)
	}
})

const { prefetchPreviewImage } = await import("@/features/preview/lib/previewPrefetch")
const { getPreviewStreamId, clearPreviewCache } = await import("@/features/preview/lib/previewCache")

const DESKTOP: DeviceProfile = { heicNative: "no", jxlNative: "yes", appleMobile: false, mobile: false, phone: false, pdfRangedMax: null }
const PHONE: DeviceProfile = { ...DESKTOP, mobile: true, phone: true }

function fileNamed(name: string, size = 1000n): DriveItem {
	const file: File = {
		uuid: testUuid(name.replace(/\W/g, "")),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size, key: "k", version: 2 }
		}
	}

	return narrowItem(file)
}

const images: FakeImage[] = []

class FakeImage {
	public src = ""
	public decode = vi.fn(() => Promise.resolve())
	public removeAttribute = vi.fn((name: string) => {
		if (name === "src") this.src = ""
	})

	public constructor() {
		images.push(this)
	}
}

async function settle(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.stubGlobal("Image", FakeImage)
	stream.available = true
	held.bytes.clear()
	images.length = 0
	clearPreviewCache()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("prefetchPreviewImage", () => {
	it("loads a native image from the stream id its slot will reuse, and releases it on dispose", async () => {
		const item = fileNamed("beach.jpg")
		const dispose = prefetchPreviewImage(item, "authed", "authed", DESKTOP)

		expect(dispose).not.toBeNull()
		expect(stream.hold).toHaveBeenCalledTimes(1)

		const id = stream.hold.mock.calls[0]?.[0]

		await settle()

		expect(stream.url).toHaveBeenCalledWith(expect.anything(), "beach.jpg", "image/jpeg", id, { access: "authed" })
		expect(getPreviewStreamId("authed", item.data.uuid, "image/jpeg")).toBe(id)
		expect(images).toHaveLength(1)
		expect(images[0]?.src).toBe(`/sw/preview/${String(id)}`)
		expect(images[0]?.decode).toHaveBeenCalledTimes(1)
		expect(stream.release).not.toHaveBeenCalled()

		dispose?.()

		expect(images[0]?.removeAttribute).toHaveBeenCalledWith("src")
		expect(stream.release).toHaveBeenCalledWith(id)
	})

	it("reuses the stream id an earlier view registered", async () => {
		const item = fileNamed("beach.jpg")

		prefetchPreviewImage(item, "authed", "authed", DESKTOP)?.()
		await settle()

		const first = stream.hold.mock.calls[0]?.[0]

		prefetchPreviewImage(item, "authed", "authed", DESKTOP)

		expect(stream.hold.mock.calls[1]?.[0]).toBe(first)
	})

	it("a prefetch disposed before its URL resolved loads nothing", async () => {
		prefetchPreviewImage(fileNamed("beach.jpg"), "authed", "authed", DESKTOP)?.()
		await settle()

		expect(images).toHaveLength(0)
		expect(stream.release).toHaveBeenCalledTimes(1)
	})

	it("does not prefetch a video, a decoded-route image, a fresh-id image, a buffered one or a phone-gated large one", () => {
		expect(prefetchPreviewImage(fileNamed("clip.mp4"), "authed", "authed", DESKTOP)).toBeNull()
		// HEIC this browser does not decode: the decoded route.
		expect(prefetchPreviewImage(fileNamed("photo.heic"), "authed", "authed", DESKTOP)).toBeNull()
		// HEIC still being probed.
		expect(prefetchPreviewImage(fileNamed("photo.heic"), "authed", "authed", { ...DESKTOP, heicNative: "unknown" })).toBeNull()
		// JXL streams here but registers under a fresh id each time.
		expect(prefetchPreviewImage(fileNamed("photo.jxl"), "authed", "authed", DESKTOP)).toBeNull()

		const buffered = fileNamed("held.jpg")

		held.bytes.add(buffered.data.uuid)
		expect(prefetchPreviewImage(buffered, "authed", "authed", DESKTOP)).toBeNull()

		const large = fileNamed("large.jpg", 2n * 1024n * 1024n)

		expect(prefetchPreviewImage(large, "authed", "authed", PHONE)).toBeNull()
		expect(prefetchPreviewImage(large, "authed", "authed", DESKTOP)).not.toBeNull()
		expect(stream.hold).toHaveBeenCalledTimes(1)
	})

	it("does not prefetch without a cache scope or a service worker", () => {
		expect(prefetchPreviewImage(fileNamed("beach.jpg"), null, "anon", DESKTOP)).toBeNull()

		stream.available = false
		expect(prefetchPreviewImage(fileNamed("beach.jpg"), "authed", "authed", DESKTOP)).toBeNull()
		expect(stream.hold).not.toHaveBeenCalled()
	})
})
