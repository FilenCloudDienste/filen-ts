// @vitest-environment jsdom

// The notes' server writes as activity toasts: the per-note and tag menus' direct actions, note creation
// (shown only while it runs), and the Undo of a trash or archive. The writes themselves are stubbed;
// notesActions/notesTags/notesBulk tests cover them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { ExternalToast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { mockNote, mockNoteTag, undecryptableNote } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"
import { plainErrorDTO } from "@/lib/sdk/errors"
import "@/lib/i18n"

const { toast, actions, tags, trashNotes, archiveNotes, revertNoteDispositions } = vi.hoisted(() => ({
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
	trashNotes: vi.fn(),
	archiveNotes: vi.fn(),
	revertNoteDispositions: vi.fn()
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/notes/lib/actions", () => actions)
vi.mock("@/features/notes/lib/tags", () => tags)
vi.mock("@/features/notes/lib/bulk", () => ({
	trashNotes,
	archiveNotes,
	revertNoteDispositions,
	deleteNotesPermanently: vi.fn(),
	leaveNotes: vi.fn()
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => () => Promise.resolve(),
	useRouter: () => ({ state: { location: { pathname: "/notes" } } }),
	useRouterState: () => ""
}))

const { NoteDropdownMenuContent, TagContextMenuContent } = await import("@/features/notes/components/noteMenu")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu")
const { noteActivityName, notesArchiveActivity, notesTrashActivity } = await import("@/features/notes/lib/activity")
const { runBulkActivity } = await import("@/lib/activity/activity")

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

// Trash and archive are reversible: they run unconfirmed and their result offers Undo, which puts back exactly the notes
// the action moved, as they were before it.
describe("trash and archive undo", () => {
	function undoAction(): () => void {
		const action = toast.success.mock.lastCall?.[1]?.action

		if (action === undefined || action === null || typeof action !== "object" || !("onClick" in action) || action.label !== "Undo") {
			throw new Error("no Undo action")
		}

		return () => {
			action.onClick({} as never)
		}
	}

	it("offers Undo on a bulk trash, reverting every trashed note and only those", async () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "a" }), mockNote({ uuid: testUuid("b"), title: "b" })]
		const already = mockNote({ uuid: testUuid("c"), title: "c", trash: true })
		trashNotes.mockResolvedValue({ succeeded: [...notes, already], failed: [] })
		revertNoteDispositions.mockResolvedValue({ succeeded: notes, failed: [] })

		await runBulkActivity(notesTrashActivity([...notes, already]))

		expect(toast.success).toHaveBeenCalledWith("Moved 3 notes to trash", expect.anything())

		undoAction()()

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Restored 2 notes", expect.anything())
		})
		expect(revertNoteDispositions.mock.calls[0]?.[0]).toEqual(notes)
	})

	it("offers no Undo when a note failed (Try again takes its place) or nothing moved", async () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "a" }), mockNote({ uuid: testUuid("b"), title: "b" })]
		trashNotes.mockResolvedValue({ succeeded: [notes[0]], failed: [{ item: notes[1], error: plainErrorDTO("nope") }] })

		await runBulkActivity(notesTrashActivity(notes))

		expect(toast.error.mock.lastCall?.[1]?.action).toMatchObject({ label: "Try again" })

		const archived = mockNote({ uuid: testUuid("d"), title: "d", archive: true })
		archiveNotes.mockResolvedValue({ succeeded: [archived], failed: [] })

		await runBulkActivity(notesArchiveActivity([archived]))

		expect(toast.success.mock.lastCall?.[1]?.action).toBeUndefined()
	})

	it("trashes from the note menu without a confirm, its Undo restoring the note", async () => {
		actions.trashNote.mockResolvedValue({ status: "success", item: { ...note, trash: true } })
		revertNoteDispositions.mockResolvedValue({ succeeded: [note], failed: [] })
		renderNoteMenu()

		clickItem("Trash")

		expect(screen.queryByRole("alertdialog")).toBeNull()

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Moved Groceries to trash", expect.anything())
		})

		undoAction()()

		await vi.waitFor(() => {
			expect(revertNoteDispositions).toHaveBeenCalledOnce()
		})
		expect(revertNoteDispositions.mock.calls[0]?.[0]).toEqual([note])
	})
})
