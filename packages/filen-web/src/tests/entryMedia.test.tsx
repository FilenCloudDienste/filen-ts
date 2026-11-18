// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { AnyFile } from "@filen/sdk-rs"
import type { ByteOrigin, EntryAccessKind } from "@/lib/sdk/byteOrigin"
import "@/lib/i18n"

// An archive entry's video or audio (W6 §3.10): a mapped or seekable one streams from its range port, a seekable one
// with the seek note under the player (§6.2 A), one read only whole (or one the service worker cannot serve, small
// enough) from one Blob; one the browser cannot play names its codecs from a probe of its stream's head, or of the Blob
// it plays. A tracker module decodes through the synthesizer's stream.

type StreamResult = { status: "success"; url: string; refetch: () => void } | { status: "error"; refetch: () => void }

const { readOriginProbe, streamUrl, downloadOriginBytes, cancelPreviewDownload, openDecodedAudioStream } = vi.hoisted(() => ({
	readOriginProbe: vi.fn((): Promise<null> => Promise.resolve(null)),
	streamUrl: vi.fn((): StreamResult => ({ status: "success", url: "/sw/entry", refetch: () => undefined })),
	downloadOriginBytes: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
	cancelPreviewDownload: vi.fn(() => Promise.resolve()),
	openDecodedAudioStream: vi.fn(() => Promise.resolve({ url: "/sw/pcm", info: { id: "pcm" }, release: vi.fn() }))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { readOriginProbe, downloadOriginBytes, cancelPreviewDownload } }))
vi.mock("@/features/preview/hooks/usePreviewStreamUrl", () => ({ usePreviewStreamUrl: streamUrl }))
vi.mock("@/lib/media/playback/audioStream", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/media/playback/audioStream")>()),
	openDecodedAudioStream
}))
vi.mock("@/features/preview/lib/previewStream", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/preview/lib/previewStream")>()),
	isMediaStreamAvailable: () => true,
	holdPreviewStreamAlive: () => () => undefined
}))

const { MediaViewer } = await import("@/features/preview/components/mediaViewer")
const { PreviewByteOriginProvider } = await import("@/features/preview/lib/accessMode")
const { archiveEntryItem } = await import("@/features/archive/lib/entryItem")
const { entryLeaseOrigin } = await import("@/features/archive/lib/archiveHandle")
const { bytesOrigin } = await import("@/lib/sdk/byteOrigin")
const { clearPreviewCache, getPreviewBytes } = await import("@/features/preview/lib/previewCache")

const ARCHIVE = { uuid: "a0000000-0000-0000-0000-000000000000" } as unknown as AnyFile
const MiB = 1024 * 1024

beforeAll(() => {
	URL.createObjectURL = vi.fn(() => "blob:entry")
	URL.revokeObjectURL = vi.fn()
})

function showOrigin(origin: ByteOrigin, name = "clip.mp4", category: "video" | "audio" = "video", size = 1000) {
	return render(
		<PreviewByteOriginProvider origin={origin}>
			<MediaViewer
				item={archiveEntryItem(ARCHIVE.uuid, 3, name, size, Number.NaN)}
				category={category}
				alt={name}
			/>
		</PreviewByteOriginProvider>
	)
}

function show(access: EntryAccessKind, size = 1000): { origin: ByteOrigin; unmount: () => void } {
	const origin = entryLeaseOrigin("lease", ARCHIVE.uuid, false, 3, size, access)
	const { unmount } = showOrigin(origin, "clip.mp4", "video", size)

	return { origin, unmount }
}

afterEach(() => {
	cleanup()
	clearPreviewCache()
	vi.clearAllMocks()
	streamUrl.mockImplementation(() => ({ status: "success", url: "/sw/entry", refetch: () => undefined }))
})

describe("entry media", () => {
	it("streams a mapped entry from its range port, with no seek note", () => {
		show("mapped")

		expect(screen.getByLabelText("clip.mp4").getAttribute("src")).toBe("/sw/entry")
		expect(screen.queryByText(/seeking may pause/)).toBeNull()
	})

	it("says under a seekable entry's player that a seek may pause", () => {
		show("seekable")

		expect(screen.getByText("Compressed in the archive · seeking may pause while it reads")).toBeTruthy()
	})

	it("probes a streamed entry's head through its origin when the browser cannot play it, and cancels it on unmount", async () => {
		readOriginProbe.mockReturnValueOnce(new Promise(() => undefined))

		const { origin, unmount } = show("mapped")

		fireEvent.error(screen.getByLabelText("clip.mp4"))
		await vi.waitFor(() => {
			expect(readOriginProbe).toHaveBeenCalledWith(origin, "authed", "card", expect.any(String))
		})

		const token = (readOriginProbe.mock.calls[0] as unknown[] | undefined)?.[3]

		unmount()
		expect(cancelPreviewDownload).toHaveBeenCalledWith(token)
	})

	it("names the format a streamed entry the browser cannot play holds", async () => {
		show("mapped")

		fireEvent.error(screen.getByLabelText("clip.mp4"))
		expect(await screen.findByText(/format/i)).toBeTruthy()
	})

	it("plays an entry read only whole from one Blob, kept out of the preview cache, and probes that Blob", async () => {
		show("whole")

		const element = await screen.findByLabelText("clip.mp4")

		expect(element.getAttribute("src")).toBe("blob:entry")
		expect(downloadOriginBytes).toHaveBeenCalledTimes(1)
		expect(getPreviewBytes(null, `${ARCHIVE.uuid}#3`)).toBeUndefined()

		fireEvent.error(element)
		expect(await screen.findByText(/format/i)).toBeTruthy()
		expect(readOriginProbe).not.toHaveBeenCalled()
	})

	it("plays an attachment from the Blob its holder has, reading nothing", async () => {
		showOrigin(bytesOrigin(new Blob([new Uint8Array([1, 2, 3])]), "mail/1"))

		expect((await screen.findByLabelText("clip.mp4")).getAttribute("src")).toBe("blob:entry")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})

	it("plays a small streamable entry from a buffer where the service worker cannot serve it", async () => {
		streamUrl.mockImplementation(() => ({ status: "error", refetch: () => undefined }))
		show("mapped")

		expect((await screen.findByLabelText("clip.mp4")).getAttribute("src")).toBe("blob:entry")
		expect(downloadOriginBytes).toHaveBeenCalledTimes(1)
	})

	it("says a large one cannot be streamed there, reading nothing", () => {
		streamUrl.mockImplementation(() => ({ status: "error", refetch: () => undefined }))
		show("mapped", 65 * MiB)

		expect(screen.getByText(/stream/i)).toBeTruthy()
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})

	it("decodes a tracker module through the synthesizer from its origin", async () => {
		const origin = entryLeaseOrigin("lease", ARCHIVE.uuid, false, 3, 1000, "whole")

		showOrigin(origin, "song.mod", "audio")

		await vi.waitFor(() => {
			expect(openDecodedAudioStream).toHaveBeenCalledWith(expect.objectContaining({ origin }))
		})
		expect((openDecodedAudioStream.mock.calls[0] as unknown[] | undefined)?.[0]).toHaveProperty("synth")
		expect((await screen.findByLabelText("song.mod")).getAttribute("src")).toBe("/sw/pcm")
		expect(downloadOriginBytes).not.toHaveBeenCalled()
	})
})
