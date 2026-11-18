// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { AnyFile } from "@filen/sdk-rs"
import type { ByteOrigin, EntryAccessKind } from "@/lib/sdk/byteOrigin"
import "@/lib/i18n"

// An archive entry's video or audio (W6 §3.10): a mapped or seekable one streams from its range port, a seekable one
// with the seek note under the player (§6.2 A); one the browser cannot play names its codecs from readOriginProbe.

const { readOriginProbe, streamUrl } = vi.hoisted(() => ({
	readOriginProbe: vi.fn(() => Promise.resolve(null)),
	streamUrl: vi.fn(() => ({ status: "success", url: "/sw/entry", refetch: () => undefined }))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { readOriginProbe } }))
vi.mock("@/features/preview/hooks/usePreviewStreamUrl", () => ({ usePreviewStreamUrl: streamUrl }))

const { MediaViewer } = await import("@/features/preview/components/mediaViewer")
const { PreviewByteOriginProvider } = await import("@/features/preview/lib/accessMode")
const { archiveEntryItem } = await import("@/features/archive/lib/entryItem")
const { entryLeaseOrigin } = await import("@/features/archive/lib/archiveHandle")

const ARCHIVE = { uuid: "a0000000-0000-0000-0000-000000000000" } as unknown as AnyFile

function show(access: EntryAccessKind): ByteOrigin {
	const origin = entryLeaseOrigin("lease", ARCHIVE, false, 3, 1000, access)

	render(
		<PreviewByteOriginProvider origin={origin}>
			<MediaViewer
				item={archiveEntryItem(ARCHIVE.uuid, 3, "clip.mp4", 1000, Number.NaN)}
				category="video"
				alt="clip.mp4"
			/>
		</PreviewByteOriginProvider>
	)

	return origin
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
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

	it("asks the probe through the entry's origin when the browser cannot play it", async () => {
		const origin = show("mapped")

		fireEvent.error(screen.getByLabelText("clip.mp4"))
		await vi.waitFor(() => {
			expect(readOriginProbe).toHaveBeenCalledWith(origin, "authed", "full", expect.any(String))
		})
		expect(await screen.findByText(/format/i)).toBeTruthy()
	})
})
