// @vitest-environment jsdom

// Render cases for the notes bulk bar: one bulk run at a time, no run while a selected note still has
// queued edits, and every run as an activity toast in its own words. The bulk operations themselves are
// stubbed; notesBulk.test.ts covers them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { ExternalToast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"
import { testUuid } from "@/tests/support/uuid"
import { mockNote } from "@/tests/fixtures/notes"
import "@/lib/i18n"

const { duplicateNotes, setPinnedNotes, toast } = vi.hoisted(() => ({
	duplicateNotes: vi.fn<(notes: Note[], onSettled?: BulkProgress) => Promise<BulkOutcome<Note>>>(),
	setPinnedNotes: vi.fn<(notes: Note[], pinned: boolean, onSettled?: BulkProgress) => Promise<BulkOutcome<Note>>>(),
	toast: Object.assign(
		vi.fn<(title: string, options?: ExternalToast) => string>(() => "id"),
		{
			success: vi.fn<(title: string, options?: ExternalToast) => string>(),
			error: vi.fn<(title: string, options?: ExternalToast) => string>(),
			warning: vi.fn<(title: string, options?: ExternalToast) => string>(),
			dismiss: vi.fn()
		}
	)
}))

vi.mock("sonner", () => ({ toast }))

vi.mock("@/features/notes/lib/bulk", () => ({
	setPinnedNotes,
	setFavoritedNotes: vi.fn(),
	setTypeNotes: vi.fn(),
	duplicateNotes,
	archiveNotes: vi.fn(),
	restoreNotes: vi.fn(),
	setTagOnNotes: vi.fn()
}))

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const { NotesBulkActionBar } = await import("@/features/notes/components/notesBulkActionBar")
const { useNotesInflightStore } = await import("@/features/notes/store/useNotesInflight")
const { useNotesSelectionStore } = await import("@/features/notes/store/useNotesSelectionStore")

const first = mockNote({ uuid: testUuid("a"), title: "a" })
const edited = mockNote({ uuid: testUuid("b"), title: "b" })
const notes = [first, edited]

function duplicateButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: "Duplicate" })
}

beforeEach(() => {
	vi.clearAllMocks()
	useNotesInflightStore.setState({ inflightContent: {} })
	useNotesSelectionStore.setState({ selectedNotes: notes })
})

afterEach(() => {
	cleanup()
})

function renderBar(selectedNotes: Note[] = notes): void {
	render(
		createElement(NotesBulkActionBar, {
			selectedNotes,
			allTags: [],
			currentUserId: 1n,
			onDialogAction: () => undefined
		})
	)
}

describe("NotesBulkActionBar — run gating", () => {
	it("runs a bulk duplicate once however often it is clicked while running", async () => {
		const { promise, resolve: finish } = Promise.withResolvers<BulkOutcome<Note>>()

		duplicateNotes.mockReturnValue(promise)
		renderBar()

		fireEvent.click(duplicateButton())
		fireEvent.click(duplicateButton())

		expect(duplicateNotes).toHaveBeenCalledTimes(1)
		expect(duplicateButton().disabled).toBe(true)

		await act(async () => {
			finish({ succeeded: [], failed: [] })
			await promise
		})

		await vi.waitFor(() => {
			expect(duplicateButton().disabled).toBe(false)
		})
	})

	it("disables every action while a selected note has queued edits", () => {
		useNotesInflightStore.setState({
			inflightContent: { [edited.uuid]: [{ content: "typed", timestamp: 0, note: edited }] }
		})
		renderBar()

		fireEvent.click(duplicateButton())

		expect(duplicateButton().disabled).toBe(true)
		expect(duplicateNotes).not.toHaveBeenCalled()
	})
})

describe("NotesBulkActionBar — activities", () => {
	it("runs a duplicate as an activity counting the selection, then prunes what succeeded", async () => {
		duplicateNotes.mockImplementation((_targets, onSettled) => {
			onSettled?.(1, 2)
			onSettled?.(2, 2)

			return Promise.resolve({ succeeded: [edited], failed: [{ item: first, error: new Error("boom") }] })
		})
		renderBar()

		fireEvent.click(duplicateButton())

		expect(toast.mock.lastCall?.[0]).toBe("Duplicating 2 notes")

		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Duplicated 1 note, 1 failed", expect.objectContaining({ description: "boom" }))
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([first])
	})

	it("pins the whole selection, or unpins it once any selected note is pinned", async () => {
		setPinnedNotes.mockImplementation(targets => Promise.resolve({ succeeded: targets, failed: [] }))
		renderBar([mockNote({ uuid: testUuid("c"), title: "c", pinned: true }), ...notes])

		fireEvent.click(screen.getByRole("button", { name: "Unpin" }))

		expect(setPinnedNotes).toHaveBeenCalledWith(expect.any(Array), false, expect.any(Function))
		expect(toast.mock.lastCall?.[0]).toBe("Unpinning 3 notes")

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Unpinned 3 notes", expect.anything())
		})
	})
})
