// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import type { DriveItem } from "@/features/drive/lib/item"
import "@/lib/i18n"

// A Pages, Numbers or Keynote file behind a public link previews as the drive's does: its package listed and the
// rendering it carries read through the public-link client's archive reader, at any size.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient: () => Promise.resolve(false) } }))
// The iWork preview itself is iworkPreview.tsx's: this one says where it would read the package from.
vi.mock("@/features/iwork/components/iworkPreview", async () => {
	const { usePreviewOrigin } = await import("@/features/preview/lib/accessMode")

	return {
		IworkPreview: ({ item }: { item: DriveItem }) => createElement("p", null, `iwork from ${usePreviewOrigin(item).kind}`)
	}
})
vi.mock("@/features/preview/components/readOnlyPreviewBody", () => ({
	ReadOnlyPreviewBody: ({ category }: { category: string }) => createElement("p", null, `body:${category}`)
}))

const { anonPreviewability } = await import("@/features/publicLinks/lib/download.logic")
const { PublicPreview } = await import("@/features/publicLinks/components/publicPreview")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")

const GiB = 1024n * 1024n * 1024n

afterEach(() => {
	cleanup()
})

describe("a public link's iWork document", () => {
	it.each(["report.pages", "budget.numbers"])("%s previews at any size, never read whole", name => {
		expect(anonPreviewability(linkedFileItem(name, { size: 2n * GiB }))).toBe("previewable")
	})

	it("opens in the iWork preview, reading the package through the public-link client", () => {
		const item = linkedFileItem("report.pages", { uuid: "e7000000-0000-0000-0000-000000000000", size: 300n })

		render(createElement(PublicPreview, { item, linkScope: "scope", downloadable: true }))

		expect(screen.getByText("iwork from linkedFile")).toBeTruthy()
		expect(screen.queryByText(/^body:/)).toBeNull()
	})

	it("leaves every other kind to the read-only viewers", () => {
		const item = linkedFileItem("notes.txt", { uuid: "e8000000-0000-0000-0000-000000000000", size: 300n })

		render(createElement(PublicPreview, { item, linkScope: "scope", downloadable: true }))

		expect(screen.getByText("body:text")).toBeTruthy()
	})
})
