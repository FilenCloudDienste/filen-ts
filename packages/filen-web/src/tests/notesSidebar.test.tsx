// @vitest-environment jsdom

// The notes sidebar's header actions: the tags empty state's New tag button is gated offline like every other
// create-tag entry point, and Export all runs once at a time from the menu item and the shortcut alike.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Note } from "@filen/sdk-rs"
import { mockNote } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"
import "@/lib/i18n"

const { online, view, notesData, openCreateTagDialog, exportAllNotes, toastNotesExportOutcome } = vi.hoisted(() => ({
	online: { current: true },
	view: { mode: "notes" },
	notesData: { current: [] as Note[] },
	openCreateTagDialog: vi.fn(),
	exportAllNotes: vi.fn<(notes: readonly Note[]) => Promise<{ status: "success"; skipped: number }>>(),
	toastNotesExportOutcome: vi.fn()
}))

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(() => Promise.resolve()),
	useRouter: () => ({ state: { location: { pathname: "/notes" } } }),
	useRouterState: () => "/notes"
}))
vi.mock("@/features/notes/queries/notes", () => ({
	useNotes: () => ({ isPending: false, isError: false, data: notesData.current })
}))
vi.mock("@/features/notes/queries/noteTags", () => ({ useNoteTags: () => ({ isPending: false, isError: false, data: [] }) }))
vi.mock("@/features/notes/queries/preferences", () => ({
	useNotesViewModeQuery: () => ({ data: view.mode }),
	useNoteTagsSortByQuery: () => ({ data: undefined })
}))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { id: 1n } }) }))
vi.mock("@/features/notes/hooks/useNoteDialogHost", () => ({
	useNoteDialogHost: () => ({
		openNoteDialog: vi.fn(),
		openTagDialog: vi.fn(),
		openBulkDialog: vi.fn(),
		openCreateTagDialog,
		renderActiveDialog: () => null
	})
}))
vi.mock("@/features/notes/lib/export", () => ({ exportAllNotes, toastNotesExportOutcome }))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))

const { NotesSidebar } = await import("@/features/notes/components/notesSidebar")
const { queryClient } = await import("@/queries/client")
const { QueryClientProvider } = await import("@tanstack/react-query")
const { registerAllActions } = await import("@/lib/keymap/actions")
const { setUserCombo } = await import("@/lib/keymap/registry")

registerAllActions()

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined
	let reject: (reason: unknown) => void = () => undefined
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}

function renderSidebar(): void {
	render(
		<QueryClientProvider client={queryClient}>
			<NotesSidebar />
		</QueryClientProvider>
	)
}

async function openMoreMenu(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "More options" }))
	await screen.findByRole("menuitem", { name: "Export all" })
}

function pressExportAllShortcut(): void {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "U", code: "KeyU", ctrlKey: true, shiftKey: true })
	)
}

function exportAllItem(): HTMLElement {
	return screen.getByRole("menuitem", { name: "Export all" })
}

function isDisabled(element: HTMLElement): boolean {
	return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled")
}

beforeEach(() => {
	vi.clearAllMocks()
	online.current = true
	view.mode = "notes"
	notesData.current = []
})

afterEach(() => {
	cleanup()
})

describe("the tags empty state's New tag button", () => {
	it("is disabled offline and carries the offline explanation", () => {
		online.current = false
		view.mode = "tags"
		renderSidebar()

		const button = screen.getByRole("button", { name: "New tag" })

		expect(button).toHaveProperty("disabled", true)
		expect(button.getAttribute("title")).toBe("Unavailable while offline")

		fireEvent.click(button)

		expect(openCreateTagDialog).not.toHaveBeenCalled()
	})

	it("opens the create-tag dialog online", () => {
		view.mode = "tags"
		renderSidebar()

		const button = screen.getByRole("button", { name: "New tag" })

		expect(button).toHaveProperty("disabled", false)
		expect(button.getAttribute("title")).toBeNull()

		fireEvent.click(button)

		expect(openCreateTagDialog).toHaveBeenCalledOnce()
	})
})

describe("Export all", () => {
	it.each(["resolve", "reject"] as const)(
		"runs once for overlapping shortcut and menu triggers and re-enables the menu item after it settles (%s)",
		async settle => {
			await act(() => setUserCombo("notes.exportAll", "mod+shift+u"))
			notesData.current = [mockNote({ uuid: testUuid("a"), title: "a" })]

			const run = deferred<{ status: "success"; skipped: number }>()

			exportAllNotes.mockReturnValueOnce(run.promise)
			renderSidebar()

			pressExportAllShortcut()
			expect(exportAllNotes).toHaveBeenCalledOnce()

			// A second shortcut press while the first run is pending is ignored.
			pressExportAllShortcut()
			expect(exportAllNotes).toHaveBeenCalledOnce()

			// The menu item is disabled meanwhile, and a click on it starts nothing.
			await openMoreMenu()
			expect(isDisabled(exportAllItem())).toBe(true)
			fireEvent.click(exportAllItem())
			expect(exportAllNotes).toHaveBeenCalledOnce()

			await act(async () => {
				if (settle === "resolve") {
					run.resolve({ status: "success", skipped: 0 })
				} else {
					run.reject(new Error("boom"))
				}

				await run.promise.catch(() => undefined)
			})

			if (settle === "reject") {
				expect(toastNotesExportOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
			}

			expect(isDisabled(exportAllItem())).toBe(false)
			exportAllNotes.mockResolvedValueOnce({ status: "success", skipped: 0 })
			fireEvent.click(exportAllItem())
			expect(exportAllNotes).toHaveBeenCalledTimes(2)
		}
	)
})
