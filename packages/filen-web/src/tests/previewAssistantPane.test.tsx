// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// The assistant panel inside an open drive preview, whose modal dialog covers the shell's: the ✨ in its header opens
// the same panel as a pane after the viewer (the drawer below the breakpoint), the viewer is not rendered again for it,
// and the panel's keys never reach the preview's.

const { viewport, viewerRenders } = vi.hoisted(() => ({ viewport: { wide: true }, viewerRenders: { count: 0 } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() })
}))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvEntriesJson: () => Promise.resolve([]),
	kvKeys: () => Promise.resolve([]),
	kvHas: () => Promise.resolve(false),
	kvDelete: () => Promise.resolve(),
	kvDeletePrefix: () => Promise.resolve()
}))
vi.mock("@/lib/sdk/session", () => ({ hasPersistedSession: () => Promise.resolve(true), onAuthBroadcast: () => () => undefined }))
vi.mock("@/features/shell/queries/sidebarWidth", () => ({
	useSidebarWidthQuery: () => ({ data: 360, refetch: () => Promise.resolve() })
}))
vi.mock("@/features/shell/lib/breakpoints", () => ({
	isNarrowViewport: () => !viewport.wide,
	subscribeToLayoutBreakpoint: () => () => undefined
}))
vi.mock("@/features/preview/lib/previewCache", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/previewCache")>("@/features/preview/lib/previewCache")),
	loadPreviewBytes: () => Promise.resolve()
}))
vi.mock("@/features/spreadsheet/sheetViewer", () => ({
	SheetViewer: () => {
		viewerRenders.count++

		return createElement("button", { type: "button" }, "cell")
	}
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { AssistantToggle } from "@/features/assistant/components/assistantToggle"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { INITIAL_TRANSCRIPT_STATE } from "@/features/assistant/store/transcript"
import { registerAssistantSession } from "@/features/assistant/store/assistantSession"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import { withCode } from "@/tests/support/keys"

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

const onStep = vi.fn()
let unregister: () => void = () => undefined

function renderPreview(variant: DriveVariant) {
	return render(
		createElement(PreviewOverlay, {
			variant,
			items: [sheet("11111111-1111-1111-1111-111111111111", "a.xlsx"), sheet("33333333-3333-3333-3333-333333333333", "b.xlsx")],
			index: 0,
			onStep,
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)
}

function previewDialog(): HTMLElement {
	return screen.getByRole("dialog", { name: "a.xlsx" })
}

function sparkle(): HTMLElement {
	return within(previewDialog()).getByRole("button", { name: "Assistant" })
}

beforeEach(() => {
	viewport.wide = true
	viewerRenders.count = 0
	onStep.mockClear()
	useAssistantStore.setState({
		...INITIAL_TRANSCRIPT_STATE,
		panelOpen: false,
		drawerOpen: false,
		previewHosted: false,
		draft: "",
		focusRequested: false
	})
	unregister = registerAssistantSession(createMockAssistantSession({ initialState: { kind: "ready", model: MOCK_ASSISTANT_MODEL } }))
})

afterEach(() => {
	unregister()
	cleanup()
})

describe("the assistant in a drive preview", () => {
	it("hosts the panel while open, so the shell drops its own, and gives it back on close", async () => {
		const { unmount } = renderPreview("drive")

		await screen.findByRole("button", { name: "cell" })

		expect(useAssistantStore.getState().previewHosted).toBe(true)

		unmount()

		expect(useAssistantStore.getState().previewHosted).toBe(false)
	})

	it("opens the panel as a pane after the viewer from the ✨, focusing it, without rendering the viewer again", async () => {
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		const before = viewerRenders.count

		expect(sparkle().getAttribute("aria-pressed")).toBe("false")
		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()

		fireEvent.click(sparkle())

		const panel = within(previewDialog()).getByRole("complementary", { name: "Assistant" })

		expect(useAssistantStore.getState().panelOpen).toBe(true)
		expect(sparkle().getAttribute("aria-pressed")).toBe("true")
		expect(panel.contains(document.activeElement)).toBe(true)
		expect(screen.getByRole("button", { name: "cell" })).toBeDefined()
		expect(viewerRenders.count).toBe(before)

		fireEvent.click(sparkle())

		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()
		expect(viewerRenders.count).toBe(before)
	})

	it("shows a panel left open in the shell, and moves focus to the ✨ when the panel's own close takes it away", async () => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		const panel = within(previewDialog()).getByRole("complementary", { name: "Assistant" })
		const close = within(panel).getByRole("button", { name: "Close assistant" })

		act(() => {
			close.focus()
		})
		fireEvent.click(close)

		expect(useAssistantStore.getState().panelOpen).toBe(false)
		expect(document.activeElement).toBe(sparkle())
	})

	it("keeps the panel's keys from the preview's pager", async () => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		const close = within(screen.getByRole("complementary", { name: "Assistant" })).getByRole("button", { name: "Close assistant" })

		fireEvent.keyDown(close, withCode({ key: "ArrowRight" }))
		expect(onStep).not.toHaveBeenCalled()

		fireEvent.keyDown(screen.getByRole("button", { name: "cell" }), withCode({ key: "ArrowRight" }))
		expect(onStep).toHaveBeenCalledExactlyOnceWith(1)
	})

	it("toggles the pane on the assistant's key while the preview is open, never from a field", async () => {
		render(createElement(AssistantToggle, { itemClass: () => "" }))
		renderPreview("drive")

		const cell = await screen.findByRole("button", { name: "cell" })

		fireEvent.keyDown(cell, withCode({ key: "q" }))

		const panel = within(previewDialog()).getByRole("complementary", { name: "Assistant" })
		const composer = within(panel).getByRole("textbox")

		fireEvent.keyDown(composer, withCode({ key: "q" }))
		expect(useAssistantStore.getState().panelOpen).toBe(true)

		fireEvent.keyDown(cell, withCode({ key: "q" }))
		expect(useAssistantStore.getState().panelOpen).toBe(false)
		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()
	})

	it("opens the drawer over the preview below the breakpoint", async () => {
		viewport.wide = false
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		fireEvent.click(sparkle())

		expect(useAssistantStore.getState().drawerOpen).toBe(true)

		const drawer = await screen.findByRole("dialog", { name: "Assistant" })

		// The one panel, in the drawer: the preview's slot stays empty.
		expect(within(drawer).getByRole("complementary", { name: "Assistant" })).toBeDefined()
		expect(document.querySelectorAll("#assistant-panel")).toHaveLength(1)
	})

	it.each<DriveVariant>(["links", "sharedIn"])("offers nothing in a %s preview, which leaves the panel to the shell", async variant => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview(variant)
		await screen.findByRole("button", { name: "cell" })

		expect(within(previewDialog()).queryByRole("button", { name: "Assistant" })).toBeNull()
		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()
		expect(useAssistantStore.getState().previewHosted).toBe(false)
	})
})
