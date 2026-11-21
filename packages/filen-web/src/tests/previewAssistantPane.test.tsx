// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// The assistant panel inside an open preview, whose modal dialog covers the shell's: the ✨ in its header opens
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

type Uuid = `${string}-${string}-${string}-${string}-${string}`

// `parent` the uuid itself: a chat's or a note's linked file (isLinkedEmbedItem).
function sheet(uuid: Uuid, name: string, parent: Uuid = "22222222-2222-2222-2222-222222222222") {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent,
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
const onClose = vi.fn()
let unregister: () => void = () => undefined

function renderPreview(
	variant: DriveVariant,
	items = [sheet("11111111-1111-1111-1111-111111111111", "a.xlsx"), sheet("33333333-3333-3333-3333-333333333333", "b.xlsx")]
) {
	return render(
		createElement(PreviewOverlay, {
			variant,
			items,
			index: 0,
			onStep,
			onClose,
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
	onClose.mockClear()
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

describe("the assistant in a preview", () => {
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

	it.each<DriveVariant>(["recents", "favorites", "trash", "links", "sharedIn", "sharedOut"])(
		"shows the panel in a %s preview too",
		async variant => {
			useAssistantStore.setState({ panelOpen: true })
			renderPreview(variant)
			await screen.findByRole("button", { name: "cell" })

			expect(sparkle()).toBeDefined()
			expect(within(previewDialog()).getByRole("complementary", { name: "Assistant" })).toBeDefined()
			expect(useAssistantStore.getState().previewHosted).toBe(true)
		}
	)

	it("offers nothing for a chat's or a note's linked file, which leaves the panel to the shell", async () => {
		const uuid = "44444444-4444-4444-4444-444444444444"

		useAssistantStore.setState({ panelOpen: true })
		renderPreview("links", [sheet(uuid, "a.xlsx", uuid)])
		await screen.findByRole("button", { name: "cell" })

		expect(within(previewDialog()).queryByRole("button", { name: "Assistant" })).toBeNull()
		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()
		expect(useAssistantStore.getState().previewHosted).toBe(false)
	})
})

describe("Escape in the preview's pane", () => {
	it("closes the pane first, focus back on the viewer's layer, and the preview on the next", async () => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		const composer = within(screen.getByRole("complementary", { name: "Assistant" })).getByRole("textbox")

		act(() => {
			composer.focus()
		})
		fireEvent.keyDown(composer, withCode({ key: "Escape" }))

		expect(useAssistantStore.getState().panelOpen).toBe(false)
		expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull()
		expect(document.activeElement).toBe(previewDialog())
		expect(onClose).not.toHaveBeenCalled()

		fireEvent.keyDown(previewDialog(), withCode({ key: "Escape" }))

		await vi.waitFor(() => {
			expect(onClose).toHaveBeenCalledOnce()
		})
	})

	it("leaves an Escape something in the pane took first to it", async () => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		const composer = within(screen.getByRole("complementary", { name: "Assistant" })).getByRole("textbox")

		composer.addEventListener("keydown", event => {
			event.preventDefault()
		})
		fireEvent.keyDown(composer, withCode({ key: "Escape" }))

		expect(useAssistantStore.getState().panelOpen).toBe(true)
		expect(onClose).not.toHaveBeenCalled()
	})

	it("closes a menu opened in the pane first, the pane staying", async () => {
		useAssistantStore.setState({ panelOpen: true })
		renderPreview("drive")
		await screen.findByRole("button", { name: "cell" })

		fireEvent.click(within(screen.getByRole("complementary", { name: "Assistant" })).getByRole("button", { name: "More options" }))

		const menu = await screen.findByRole("menu")

		fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0] ?? menu, withCode({ key: "Escape" }))

		await vi.waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})
		expect(useAssistantStore.getState().panelOpen).toBe(true)
		expect(onClose).not.toHaveBeenCalled()
	})
})
