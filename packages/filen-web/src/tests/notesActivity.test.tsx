// @vitest-environment jsdom

// The notes' server writes as activity toasts: the per-note and tag menus' direct actions, note creation
// (shown only while it runs), and the bulk confirm dialogs' hand-off. The writes themselves are stubbed;
// notesActions/notesTags/notesBulk tests cover them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { ExternalToast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { mockNote, mockNoteTag, undecryptableNote } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"
import { plainErrorDTO } from "@/lib/sdk/errors"
import "@/lib/i18n"

const { toast, actions, tags, trashNotes } = vi.hoisted(() => ({
	toast: Object.assign(
		vi.fn<(title: string, options?: ExternalToast) => string>(() => "id"),
		{
			success: vi.fn<(title: string, options?: ExternalToast) => string>(),
			error: vi.fn<(title: string, options?: ExternalToast) => string>(),
			warning: vi.fn<(title: string, options?: ExternalToast) => string>(),
			dismiss: vi.fn()
		}
	),
	actions: {
		togglePinned: vi.fn(),
		toggleFavorited: vi.fn(),
		duplicateNote: vi.fn(),
		archiveNote: vi.fn(),
		restoreNote: vi.fn(),
		trashNote: vi.fn(),
		setNoteType: vi.fn(),
		resolveNoteContent: vi.fn(),
		createNote: vi.fn(),
		setNoteTitle: vi.fn(),
		deleteNote: vi.fn(),
		leaveNote: vi.fn()
	},
	tags: {
		addTagToNote: vi.fn(),
		removeTagFromNote: vi.fn(),
		setNoteTagFavorited: vi.fn(),
		createNoteTag: vi.fn(),
		renameNoteTag: vi.fn(),
		deleteNoteTag: vi.fn()
	},
	trashNotes: vi.fn()
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/notes/lib/actions", () => actions)
vi.mock("@/features/notes/lib/tags", () => tags)
vi.mock("@/features/notes/lib/bulk", () => ({ trashNotes, deleteNotesPermanently: vi.fn(), leaveNotes: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => () => Promise.resolve(),
	useRouter: () => ({ state: { location: { pathname: "/notes" } } }),
	useRouterState: () => ""
}))

const { NoteDropdownMenuContent, TagContextMenuContent } = await import("@/features/notes/components/noteMenu")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu")
const { noteActivityName } = await import("@/features/notes/lib/activity")
const { useNoteDialogHost } = await import("@/features/notes/hooks/useNoteDialogHost")
const { useNotesSelectionStore } = await import("@/features/notes/store/useNotesSelectionStore")

const note = mockNote({ uuid: testUuid("n"), title: "Groceries" })
const tag = mockNoteTag({ uuid: testUuid("t"), name: "Home" })

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

function renderNoteMenu(onDuplicated?: (duplicated: Note) => void): void {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(NoteDropdownMenuContent, { note, allTags: [tag], currentUserId: 1n, onAction: () => undefined, onDuplicated })
		)
	)
}

function renderTagMenu(onCreateNoteInTag: (created: Note) => void = () => undefined): void {
	render(
		createElement(
			ContextMenu,
			null,
			createElement(ContextMenuTrigger, null, "tag"),
			createElement(TagContextMenuContent, { tag, onTagAction: () => undefined, onCreateNoteInTag })
		)
	)
	fireEvent.contextMenu(screen.getByText("tag"))
}

function clickItem(name: string): void {
	fireEvent.click(screen.getByRole("menuitem", { name }))
}

describe("noteActivityName", () => {
	it("names a note as the list does", () => {
		expect(noteActivityName(note)).toBe("Groceries")
		expect(noteActivityName(mockNote({ title: "" }))).toBe("Untitled note")
		expect(noteActivityName(undecryptableNote())).toBe("Cannot decrypt")
	})
})

describe("note menu — direct writes as activities", () => {
	it("pins a note in its own words", async () => {
		actions.togglePinned.mockResolvedValue({ status: "success", item: { ...note, pinned: true } })
		renderNoteMenu()

		clickItem("Pin")

		expect(toast.mock.lastCall?.[0]).toBe("Pinning Groceries")

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Pinned Groceries", expect.anything())
		})
		expect(actions.togglePinned).toHaveBeenCalledExactlyOnceWith(note)
	})

	it("says why a trash failed and offers to try it again", async () => {
		actions.trashNote.mockResolvedValue({ status: "error", dto: plainErrorDTO("nope") })
		renderNoteMenu()

		clickItem("Trash")

		expect(toast.mock.lastCall?.[0]).toBe("Moving Groceries to trash")

		await vi.waitFor(() => {
			expect(toast.error.mock.lastCall?.[0]).toBe("Couldn't move Groceries to trash")
		})
		expect(toast.error.mock.lastCall?.[1]?.description).toBe("nope")
		expect(toast.error.mock.lastCall?.[1]?.action).toBeDefined()
	})

	it("duplicates, opening the copy", async () => {
		const copy = mockNote({ uuid: testUuid("copy"), title: "Groceries" })
		const onDuplicated = vi.fn()
		actions.duplicateNote.mockResolvedValue({ status: "success", item: copy })
		renderNoteMenu(onDuplicated)

		clickItem("Duplicate")

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Duplicated Groceries", expect.anything())
		})
		expect(onDuplicated).toHaveBeenCalledExactlyOnceWith(copy)
	})

	it("tags a note and changes its type, naming the tag and the type", async () => {
		tags.addTagToNote.mockResolvedValue({ status: "success", item: note })
		actions.setNoteType.mockResolvedValue({ status: "success", item: note })
		renderNoteMenu()

		fireEvent.click(screen.getByRole("menuitem", { name: "Tags" }))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Home" }))

		expect(toast.mock.lastCall?.[0]).toBe("Tagging Groceries with Home")
		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Tagged Groceries with Home", expect.anything())
		})

		fireEvent.click(screen.getByRole("menuitem", { name: "Change type" }))
		fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Markdown" }))

		expect(toast.mock.lastCall?.[0]).toBe("Changing Groceries to Markdown")
		expect(actions.setNoteType).toHaveBeenCalledExactlyOnceWith(note, "md")
	})
})

describe("tag menu", () => {
	it("favorites a tag, naming it", async () => {
		tags.setNoteTagFavorited.mockResolvedValue({ status: "success", item: { ...tag, favorite: true } })
		renderTagMenu()

		clickItem("Favorite")

		expect(toast.mock.lastCall?.[0]).toBe("Adding Home to favorites")
		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Added Home to favorites", expect.anything())
		})
		expect(tags.setNoteTagFavorited).toHaveBeenCalledExactlyOnceWith(tag, true)
	})

	it("creates a note in the tag: running only while it runs, then opens it", async () => {
		const created = mockNote({ uuid: testUuid("new"), title: "" })
		const tagged: Note = { ...created, tags: [tag] }
		const onCreateNoteInTag = vi.fn()
		actions.createNote.mockResolvedValue({ status: "success", item: created })
		tags.addTagToNote.mockResolvedValue({ status: "success", item: tagged })
		renderTagMenu(onCreateNoteInTag)

		clickItem("Create note")

		expect(toast.mock.lastCall?.[0]).toBe("Creating a note")

		await vi.waitFor(() => {
			expect(onCreateNoteInTag).toHaveBeenCalledExactlyOnceWith(tagged)
		})
		expect(toast.dismiss).toHaveBeenCalledWith(toast.mock.lastCall?.[1]?.id)
		expect(toast.success).not.toHaveBeenCalled()
	})

	it("says the tagging failed when the note was created but could not take the tag", async () => {
		const created = mockNote({ uuid: testUuid("new"), title: "" })
		const onCreateNoteInTag = vi.fn()
		actions.createNote.mockResolvedValue({ status: "success", item: created })
		tags.addTagToNote.mockResolvedValue({ status: "error", dto: plainErrorDTO("nope") })
		renderTagMenu(onCreateNoteInTag)

		clickItem("Create note")

		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Couldn't tag Untitled note with Home", expect.anything())
		})
		expect(onCreateNoteInTag).not.toHaveBeenCalled()
	})
})

describe("bulk confirm dialogs", () => {
	function Host({ notes }: { notes: Note[] }): ReactNode {
		const host = useNoteDialogHost()

		return createElement(
			"div",
			null,
			createElement(
				"button",
				{
					type: "button",
					onClick: () => {
						host.openBulkDialog("trashSelected", notes)
					}
				},
				"open"
			),
			host.renderActiveDialog()
		)
	}

	it("closes at once and hands a run of several to the activity toast, pruning what succeeded", async () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "a" }), mockNote({ uuid: testUuid("b"), title: "b" })]
		const { promise, resolve } = Promise.withResolvers<{ succeeded: Note[]; failed: [] }>()
		trashNotes.mockReturnValue(promise)
		useNotesSelectionStore.setState({ selectedNotes: notes })
		render(createElement(Host, { notes }))

		fireEvent.click(screen.getByText("open"))
		fireEvent.click(screen.getByRole("button", { name: "Trash" }))

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(toast.mock.lastCall?.[0]).toBe("Moving 2 notes to trash")

		await act(async () => {
			resolve({ succeeded: notes, failed: [] })
			await promise
		})

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Moved 2 notes to trash", expect.anything())
		})
		expect(useNotesSelectionStore.getState().selectedNotes).toEqual([])
	})

	it("keeps the dialog's spinner for one note, then shows only the result", async () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "a" })]
		trashNotes.mockResolvedValue({ succeeded: notes, failed: [] })
		render(createElement(Host, { notes }))

		fireEvent.click(screen.getByText("open"))
		fireEvent.click(screen.getByRole("button", { name: "Trash" }))

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Moved a to trash", expect.anything())
		})
		expect(toast).not.toHaveBeenCalled()
	})
})
