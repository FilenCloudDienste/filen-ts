// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// The preview's arrow keys page to the previous or next file only unmodified: Ctrl, Alt or Cmd with an arrow belongs to
// what has focus (a word or line jump, an editor's own command, the browser's), never to the pager.

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/lib/previewCache", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/previewCache")>("@/features/preview/lib/previewCache")),
	loadPreviewBytes: () => Promise.resolve()
}))
vi.mock("@/features/spreadsheet/sheetViewer", () => ({
	SheetViewer: () => createElement("button", { type: "button" }, "cell")
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

registerAllActions()

function sheet(uuid: `${string}-${string}-${string}-${string}-${string}`, name: string) {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: {
				name,
				mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				modified: 1_700_000_000_000n,
				size: 1_024n,
				key: "key",
				version: 2
			}
		}
	})
}

afterEach(() => {
	cleanup()
})

describe("PreviewOverlay arrow keys", () => {
	it("pages on a plain arrow and never on Ctrl, Alt or Cmd with one", async () => {
		const onStep = vi.fn()

		render(
			createElement(PreviewOverlay, {
				variant: "drive" as const,
				items: [sheet("11111111-1111-1111-1111-111111111111", "a.xlsx"), sheet("33333333-3333-3333-3333-333333333333", "b.xlsx")],
				index: 0,
				onStep,
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		const cell = await screen.findByRole("button", { name: "cell" })

		for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
			fireEvent.keyDown(cell, { key: "ArrowRight", [modifier]: true })
			fireEvent.keyDown(cell, { key: "ArrowLeft", [modifier]: true })
		}

		expect(onStep).not.toHaveBeenCalled()
		fireEvent.keyDown(cell, { key: "ArrowRight" })
		expect(onStep).toHaveBeenCalledExactlyOnceWith(1)
	})
})
