import { describe, it, expect, vi } from "vitest"

// notesViewModes pulls in notes/utils, which imports the NoteType enum (a runtime value) from
// @filen/sdk-rs. Note itself is a type-only import and erases.
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}
}))

import {
	NOTES_VIEW_MODES,
	NOTES_VIEW_MODE_ORDER,
	narrowNotesForViewMode,
	notesViewModeAwaitsUser,
	type NotesViewMode
} from "@/features/notes/notesViewModes"
import { type Note } from "@/types"

const ME = 1n

function note(uuid: string, ownerId: bigint, participantIds: bigint[]): Note {
	return {
		uuid,
		ownerId,
		participants: participantIds.map(userId => ({ userId, isOwner: userId === ownerId }))
	} as unknown as Note
}

// solo = yours alone, out = you shared it, in = shared to you
const NOTES = [note("solo", ME, [ME]), note("out", ME, [ME, 7n]), note("in", 7n, [7n, ME])]

function narrow(viewMode: NotesViewMode, opts?: { markedOffline?: Record<string, true>; userId?: bigint }) {
	return narrowNotesForViewMode({
		notes: NOTES,
		viewMode,
		markedOffline: opts?.markedOffline ?? {},
		userId: "userId" in (opts ?? {}) ? opts?.userId : ME
	}).map(n => n.uuid)
}

describe("narrowNotesForViewMode", () => {
	it("leaves the notes view unnarrowed", () => {
		expect(narrow("notes")).toEqual(["solo", "out", "in"])
	})

	it("narrows the offline view to the ledger", () => {
		expect(narrow("offline", { markedOffline: { in: true } })).toEqual(["in"])
	})

	it("narrows the shared view to the notes somebody else is on, in either direction", () => {
		expect(narrow("shared")).toEqual(["out", "in"])
	})

	it("yields nothing for the shared view until the user id resolves", () => {
		expect(narrow("shared", { userId: undefined })).toEqual([])
	})

	it("does not narrow for the tags view, which renders a different list entirely", () => {
		// Reached only by a drilled-in tag screen, whose narrowing is the sorter's tag filter.
		expect(narrow("tags")).toEqual(["solo", "out", "in"])
	})

	it("covers every declared view mode", () => {
		// The compiler already enforces this (the switch has no `default` and cannot return undefined),
		// but that check disappears the moment somebody adds one — this keeps it observable at runtime.
		for (const viewMode of NOTES_VIEW_MODE_ORDER) {
			expect(Array.isArray(narrow(viewMode))).toBe(true)
		}
	})

	it("does not mutate the input", () => {
		const notes = [...NOTES]

		narrowNotesForViewMode({ notes, viewMode: "shared", markedOffline: {}, userId: ME })

		expect(notes).toHaveLength(3)
	})
})

describe("notesViewModeAwaitsUser", () => {
	it("holds only the shared view, and only until the id arrives", () => {
		// Every other view is answerable without knowing who you are, so making them wait would be a
		// spinner for nothing.
		expect(notesViewModeAwaitsUser({ viewMode: "shared", userId: undefined })).toBe(true)
		expect(notesViewModeAwaitsUser({ viewMode: "shared", userId: ME })).toBe(false)

		for (const viewMode of ["notes", "tags", "offline"] as const) {
			expect(notesViewModeAwaitsUser({ viewMode, userId: undefined })).toBe(false)
		}
	})
})

describe("NOTES_VIEW_MODES", () => {
	it("offers create only where a new note would actually appear", () => {
		// From a narrowed view the created note is neither kept on the device nor shared with anyone, so
		// it lands outside the list the user is looking at — indistinguishable from a failure. The tags
		// view creates tags, not notes, and carries its own action.
		expect(NOTES_VIEW_MODES.notes.allowsCreate).toBe(true)
		expect(NOTES_VIEW_MODES.offline.allowsCreate).toBe(false)
		expect(NOTES_VIEW_MODES.shared.allowsCreate).toBe(false)
		expect(NOTES_VIEW_MODES.tags.allowsCreate).toBe(false)
	})

	it("gives every view its own title, menu label and empty state", () => {
		// A view inheriting another's copy is the visible symptom of the fall-through this table exists
		// to prevent, so nothing here may collide.
		const titles = NOTES_VIEW_MODE_ORDER.map(mode => NOTES_VIEW_MODES[mode].titleKey)
		const emptyTitles = NOTES_VIEW_MODE_ORDER.map(mode => NOTES_VIEW_MODES[mode].empty.titleKey)
		const emptyDescriptions = NOTES_VIEW_MODE_ORDER.map(mode => NOTES_VIEW_MODES[mode].empty.descriptionKey)

		expect(new Set(titles).size).toBe(NOTES_VIEW_MODE_ORDER.length)
		expect(new Set(emptyTitles).size).toBe(NOTES_VIEW_MODE_ORDER.length)
		expect(new Set(emptyDescriptions).size).toBe(NOTES_VIEW_MODE_ORDER.length)
	})

	it("lists every mode exactly once in the menu order", () => {
		// The View submenu is built from this array; a mode missing here is a view the user can land in
		// but never leave, and a duplicate is two entries fighting over one checkmark.
		expect([...NOTES_VIEW_MODE_ORDER].sort()).toEqual(Object.keys(NOTES_VIEW_MODES).sort())
		expect(new Set(NOTES_VIEW_MODE_ORDER).size).toBe(NOTES_VIEW_MODE_ORDER.length)
	})
})
