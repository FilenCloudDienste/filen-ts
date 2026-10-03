// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { FilenPublicLink } from "@filen/shared"
import "@/lib/i18n"

// A linked archive in a chat message opens the link's page in a new tab, like a file nothing previews;
// the overlay (and its archive browser) is never reached from the card.

vi.mock("@/features/preview/components/previewOverlay", () => ({ PreviewOverlay: () => null }))

import { FilenLinkCard } from "@/features/chats/components/thread/embeds/filenLinkCard"
import type { ChatLinkResolution } from "@/features/chats/queries/chatMessageLinks"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const URL = "https://app.filen.io/f/f1000000-0000-0000-0000-000000000000#key"
const LINK: FilenPublicLink = { uuid: "f1000000-0000-0000-0000-000000000000", key: "key", type: "file" }

function renderCard(name: string): void {
	const linkedFile = mockLinkedFile({ name: { Decrypted: name }, size: 1024n })
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
})

describe("FilenLinkCard for an archive", () => {
	it("renders the new-tab link shell", () => {
		renderCard("photos.zip")

		const card = screen.getByRole("link", { name: "Open photos.zip in a new tab" })

		expect(card.getAttribute("href")).toBe(URL)
		expect(card.getAttribute("target")).toBe("_blank")
	})

	it("keeps the click-to-preview card for a previewable document", () => {
		renderCard("report.pdf")

		expect(screen.queryByRole("link")).toBeNull()
		expect(screen.getByRole("button")).toBeTruthy()
	})
})
