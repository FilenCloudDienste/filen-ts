// @vitest-environment jsdom

// Render cases for the notes bulk bar's run gating: one bulk run at a time, and no run while a selected
// note still has queued edits. The bulk operations themselves are stubbed; notesBulk.test.ts covers them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Note, UuidStr } from "@filen/sdk-rs"
import type { BulkOutcome } from "@/lib/actions/bulk"
import "@/lib/i18n"

const { duplicateNotes } = vi.hoisted(() => ({ duplicateNotes: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

vi.mock("@/features/notes/lib/bulk", () => ({
	setPinnedNotes: vi.fn(),
	setFavoritedNotes: vi.fn(),
	setTypeNotes: vi.fn(),
	duplicateNotes,
	archiveNotes: vi.fn(),
	restoreNotes: vi.fn(),
	setTagOnNotes: vi.fn()
}))

vi.mock("@/features/notes/lib/bulkToast", () => ({ toastNotesBulkOutcome: vi.fn(), toastNotesExportOutcome: vi.fn() }))

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

// Measures the bar with a ResizeObserver, which jsdom lacks; clearance is not under test.
vi.mock("@/lib/toastClearance", () => ({ toastObstructionRef: () => undefined }))

const { NotesBulkActionBar } = await import("@/features/notes/components/notesBulkActionBar")
const { useNotesInflightStore } = await import("@/features/notes/store/useNotesInflight")

function mockNote(label: string): Note {
	return {
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "note-key",
		title: label,
		preview: "",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: []
	}
}

const edited = mockNote("b")
const notes = [mockNote("a"), edited]

function duplicateButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: "Duplicate" })
}

beforeEach(() => {
	duplicateNotes.mockReset()
	useNotesInflightStore.setState({ inflightContent: {} })
})

afterEach(() => {
	cleanup()
})

function renderBar(): void {
	render(
		createElement(NotesBulkActionBar, {
			selectedNotes: notes,
			allTags: [],
			currentUserId: 1n,
			onDialogAction: () => undefined
		})
	)
}

describe("NotesBulkActionBar — run gating", () => {
	it("runs a bulk duplicate once however often it is clicked while running", async () => {
		let finish: (outcome: BulkOutcome<Note>) => void = () => undefined

		duplicateNotes.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		renderBar()

		fireEvent.click(duplicateButton())
		fireEvent.click(duplicateButton())

		expect(duplicateNotes).toHaveBeenCalledTimes(1)
		expect(duplicateButton().disabled).toBe(true)

		await act(async () => {
			finish({ succeeded: [], failed: [] })
			await Promise.resolve()
		})

		expect(duplicateButton().disabled).toBe(false)
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
