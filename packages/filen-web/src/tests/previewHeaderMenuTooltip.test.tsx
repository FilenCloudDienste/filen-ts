// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactElement, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// The preview header's ⋯ menu button names itself and its key (preview.openMenu) in its tooltip, like the header's other
// icon buttons; unbound, the tooltip keeps only the name. Off a Mac (jsdom's user agent).

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/storage/adapter", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/storage/adapter")>()),
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
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
// The tooltip's parts, flattened: its content renders beside its trigger, so a test reads what it would show.
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: (props: { children: ReactNode }) => props.children,
	TooltipTrigger: (props: { render: ReactElement }) => props.render,
	TooltipContent: (props: { children: ReactNode }) => createElement("div", { "data-testid": "tooltip" }, props.children)
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { clearUserCombo, unbindAction } from "@/lib/keymap/registry"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

registerAllActions()

function sheet() {
	return narrowItem({
		uuid: "11111111-1111-1111-1111-111111111111",
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
				name: "a.xlsx",
				mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				modified: 1_700_000_000_000n,
				size: 1_024n,
				key: "key",
				version: 2
			}
		}
	})
}

function overlay(): ReactElement {
	return createElement(PreviewOverlay, {
		variant: "drive" as const,
		items: [sheet()],
		index: 0,
		onStep: vi.fn(),
		onClose: vi.fn(),
		onItemRemoved: vi.fn()
	})
}

function menuTooltip(): HTMLElement | undefined {
	return screen.queryAllByTestId("tooltip").find(tooltip => tooltip.textContent.startsWith("More actions"))
}

afterEach(async () => {
	cleanup()
	await clearUserCombo("preview.openMenu")
})

describe("the preview header's menu button", () => {
	it("names its key in its tooltip, and only its name once unbound", async () => {
		const view = render(overlay())

		await screen.findByRole("button", { name: "cell" })
		expect(screen.getByRole("button", { name: "More actions" })).toBeDefined()
		expect([...(menuTooltip()?.querySelectorAll("[data-slot=kbd]") ?? [])].map(key => key.textContent)).toEqual(["Shift", "F10"])

		await act(async () => {
			await unbindAction("preview.openMenu")
		})
		view.rerender(overlay())

		expect(menuTooltip()?.textContent).toBe("More actions")
		expect(menuTooltip()?.querySelector("[data-slot=kbd]")).toBeNull()
	})
})
