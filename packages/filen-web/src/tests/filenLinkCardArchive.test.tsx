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

import { FilenLinkCard } from "@/features/chats/components/thread/embeds/filenLinkCard"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const URL = "https://app.filen.io/f/f1000000-0000-0000-0000-000000000000#key"
const LINK: FilenPublicLink = { uuid: "f1000000-0000-0000-0000-000000000000", key: "key", type: "file" }

function renderCard(name: string, downloadable = true): void {
	const linkedFile = mockLinkedFile({ name: { Decrypted: name }, size: 1024n, downloadable })
	const resolution: ChatLinkResolution = {
		url: URL,
		kind: "filenLink",
		link: LINK,
		success: true,
		data: { type: "file", name, size: 1024n, previewCategory: previewType(linkedFileIntoDriveItem(linkedFile)), linkedFile }
	}

	render(createElement(FilenLinkCard, { url: URL, link: LINK, resolution }))
}

afterEach(() => {
	cleanup()
	overlay.props.length = 0
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
		renderCard("setup.exe")

		const card = screen.getByRole("link", { name: "Open setup.exe in a new tab" })

		expect(card.getAttribute("href")).toBe(URL)
		expect(card.getAttribute("target")).toBe("_blank")
	})

	it("keeps the click-to-preview card for a previewable document", () => {
		renderCard("report.pdf")

		expect(screen.queryByRole("link")).toBeNull()
		expect(screen.getByRole("button")).toBeTruthy()
	})
})
