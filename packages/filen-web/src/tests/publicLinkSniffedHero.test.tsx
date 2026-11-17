// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DriveItem } from "@/features/drive/lib/item"
import "@/lib/i18n"

// A public link's file whose viewer its content read picks: the page opens on the preview, and when the read finds
// nothing the preview shows (an Illustrator file saved without a PDF inside), it falls back to the file's card.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient: () => Promise.resolve(false) } }))
// The preview's content read, as its gate records it.
vi.mock("@/features/publicLinks/components/publicPreview", async () => {
	const { recordContentVerdict } = await import("@/features/drive/lib/contentVerdicts")

	return {
		PublicPreview: ({ item }: { item: DriveItem }) => {
			useEffect(() => {
				recordContentVerdict(
					{ uuid: item.data.uuid, name: "art.ai", mime: "application/illustrator", size: item.data.size },
					"notPdfCompatible",
					{ memoryOnly: true }
				)
			}, [item])

			return createElement("p", null, "inline preview")
		}
	}
})

const { FileHero } = await import("@/features/publicLinks/components/fileHero")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")
const { resetFileKindVerdicts } = await import("@/features/drive/lib/fileKindVerdicts")
const { registerAllActions } = await import("@/lib/keymap/actions")

// The link's views bind the shared link's keys.
registerAllActions()

afterEach(() => {
	cleanup()
	resetFileKindVerdicts()
})

describe("a public link's PostScript-only Illustrator file", () => {
	it("shows its card, with Download and no Preview, once the read finds no PDF inside", async () => {
		const item = linkedFileItem("art.ai", { uuid: "e6000000-0000-0000-0000-000000000000", size: 300n })

		render(
			createElement(
				QueryClientProvider,
				{ client: new QueryClient() },
				createElement(FileHero, { item, downloadEnabled: true, linkScope: "scope" })
			)
		)

		await screen.findByRole("button", { name: "Download" })
		expect(screen.queryByText("inline preview")).toBeNull()
		expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
	})
})
