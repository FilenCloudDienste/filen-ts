// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { FilenPublicLink } from "@filen/shared"
import type { PreviewOverlayProps } from "@/features/preview/components/previewOverlay"
import "@/lib/i18n"

// A linked archive in a chat message opens the same preview overlay as a document, whose body is the
// archive browser; the link's own downloadable flag reaches the overlay, which gates the browser's
// extract on it. A file nothing previews keeps the new-tab shell.

const overlay = vi.hoisted(() => ({ props: [] as PreviewOverlayProps[] }))

vi.mock("@/features/preview/components/previewOverlay", () => ({
	PreviewOverlay: (props: PreviewOverlayProps) => {
		overlay.props.push(props)

		return null
	}
}))

// Off by default (as in jsdom, which has no service worker): only the inline-media tests below turn it on.
const stream = vi.hoisted(() => ({ available: false }))

vi.mock("@/features/preview/lib/previewStream", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/preview/lib/previewStream")>()),
	isMediaStreamAvailable: () => stream.available
}))

vi.mock("@/features/preview/hooks/usePreviewStreamUrl", () => ({
	usePreviewStreamUrl: () => ({ status: "success", url: "blob:stream", refetch: vi.fn() })
}))

import { FilenLinkCard } from "@/features/chats/components/thread/embeds/filenLinkCard"
import { MAX_INLINE_EMBED_IMAGE_BYTES } from "@/features/chats/lib/embeds.logic"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const URL = "https://app.filen.io/f/f1000000-0000-0000-0000-000000000000#key"
const LINK: FilenPublicLink = { uuid: "f1000000-0000-0000-0000-000000000000", key: "key", type: "file" }

function renderCard(name: string, downloadable = true, size = 1024n, mime = "application/octet-stream"): void {
	const linkedFile = mockLinkedFile({ name: { Decrypted: name }, mime: { Decrypted: mime }, size, downloadable })
	const resolution: ChatLinkResolution = {
		url: URL,
		kind: "filenLink",
		link: LINK,
		success: true,
		data: { type: "file", name, size, linkedFile }
	}

	render(createElement(FilenLinkCard, { url: URL, link: LINK, resolution }))
}

afterEach(() => {
	cleanup()
	overlay.props.length = 0
	stream.available = false
})

describe("FilenLinkCard for an archive", () => {
	it("renders the click-to-preview card and mounts no overlay before the click", () => {
		renderCard("photos.zip")

		expect(screen.queryByRole("link")).toBeNull()
		expect(screen.getByRole("button", { name: "Open preview of photos.zip" })).toBeTruthy()
		expect(overlay.props).toHaveLength(0)
	})

	it("opens the linked-file overlay on the archive, carrying the link's downloadable flag", () => {
		renderCard("photos.zip", false)

		fireEvent.click(screen.getByRole("button", { name: "Open preview of photos.zip" }))

		const props = overlay.props.at(-1)

		expect(props?.variant).toBe("links")
		expect(props?.downloadable).toBe(false)
		expect(props?.index).toBe(0)
		expect(props?.items).toHaveLength(1)
	})

	it("passes a downloadable link's flag through as well", () => {
		renderCard("backup.7z")

		fireEvent.click(screen.getByRole("button", { name: "Open preview of backup.7z" }))

		expect(overlay.props.at(-1)?.downloadable).toBe(true)
	})

	it("keeps the new-tab link shell for a file nothing previews", () => {
		renderCard("setup.msi")

		const card = screen.getByRole("link", { name: "Open setup.msi" })

		expect(card.getAttribute("href")).toBe(URL)
		expect(card.getAttribute("target")).toBe("_blank")
	})

	it("keeps the click-to-preview card for a previewable document", () => {
		renderCard("report.pdf")

		expect(screen.queryByRole("link")).toBeNull()
		expect(screen.getByRole("button")).toBeTruthy()
	})
})

describe("FilenLinkCard for a video", () => {
	it("never inlines a <video> for a container a plain src cannot play: the card opens the overlay instead", () => {
		for (const name of ["movie.mkv", "recording.m2ts"]) {
			renderCard(name)

			expect(document.querySelector("video")).toBeNull()
			expect(screen.getByRole("button", { name: `Open preview of ${name}` })).toBeTruthy()
			cleanup()
		}
	})

	it("keeps a .ts link a code card until a probe says otherwise", () => {
		renderCard("clip.ts")

		expect(document.querySelector("video")).toBeNull()
		expect(screen.getByRole("button", { name: "Open preview of clip.ts" })).toBeTruthy()
	})
})

describe("FilenLinkCard inline media size cap", () => {
	const CAP = BigInt(MAX_INLINE_EMBED_IMAGE_BYTES)

	it("inlines an image at the cap", () => {
		stream.available = true
		renderCard("photo.png", true, CAP, "image/png")

		expect(screen.getByRole("img", { name: "photo.png" }).getAttribute("src")).toBe("blob:stream")
	})

	it("renders the click-to-preview card for an image one byte over the cap, streaming nothing", () => {
		stream.available = true
		renderCard("photo.png", true, CAP + 1n, "image/png")

		expect(screen.queryByRole("img")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Open preview of photo.png" }))

		expect(overlay.props.at(-1)?.variant).toBe("links")
	})

	it("still inlines video and audio over the cap", () => {
		stream.available = true
		renderCard("clip.mp4", true, CAP + 1n, "video/mp4")

		expect(document.querySelector("video")).not.toBeNull()
		cleanup()

		renderCard("song.mp3", true, CAP + 1n, "audio/mpeg")

		expect(document.querySelector("audio")).not.toBeNull()
	})
})
