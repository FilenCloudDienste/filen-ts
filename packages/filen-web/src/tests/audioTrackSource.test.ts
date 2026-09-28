import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"

const { downloadFileBytes } = vi.hoisted(() => ({ downloadFileBytes: vi.fn() }))

vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: () => false,
	previewStreamUrl: vi.fn()
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadFileBytes, cancelPreviewDownload: vi.fn() } }))

import { resolveTrackSource } from "@/features/audio/lib/bytes"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

const track: QueueTrack = { uuid: "a", name: "a.mp3", mime: "audio/mpeg", contentType: null, file: {} as AnyFile }

describe("resolveTrackSource", () => {
	const urls: string[] = []

	afterEach(() => {
		for (const url of urls.splice(0)) {
			URL.revokeObjectURL(url)
		}
	})

	it("carries the downloaded Blob on a blob source, so a local read never fetches the object URL", async () => {
		const fetchSpy = vi.fn()

		vi.stubGlobal("fetch", fetchSpy)
		downloadFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

		const source = await resolveTrackSource(track, new AbortController().signal)

		if (source.kind !== "blob") {
			throw new Error("expected a blob source")
		}

		urls.push(source.url)

		expect(source.url.startsWith("blob:")).toBe(true)
		expect(source.blob.type).toBe("audio/mpeg")
		expect(new Uint8Array(await source.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
