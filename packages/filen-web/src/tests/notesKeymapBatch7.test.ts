// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionDef } from "@/lib/keymap/registry"
import { NOTES_ACTIONS } from "@/features/notes/lib/keymap"
import { availableNoteAction } from "@/features/notes/components/noteMenu.logic"
import { notesRowKeyTarget, type NotesSidebarRow } from "@/features/notes/components/notesSidebar.logic"
import { mockNote, mockNoteTag } from "@/tests/fixtures/notes"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

const { defaultComboOn } = await import("@/lib/keymap/registry")
const { ignoredOffNoteRow, rowNoteUuid } = await import("@/features/notes/lib/rowKeys")

function defFor(id: string): ActionDef {
	const def = NOTES_ACTIONS.find(action => action.id === id)

	if (def === undefined) {
		throw new Error(`missing action def: ${id}`)
	}

	return def
}

const MAC = { mac: true, desktop: false }
const OTHER = { mac: false, desktop: false }

beforeEach(() => {
	kvStore.clear()
	document.body.innerHTML = ""
})

describe("notes batch 7 defaults", () => {
	it.each([
		["notes.rename", "f2", "f2"],
		["notes.duplicate", "mod+shift+d", "mod+shift+d"],
		["notes.trash", "delete,backspace", "delete,backspace,mod+backspace"],
		["notes.deletePermanently", "shift+delete", "shift+delete,mod+alt+backspace"],
		["notes.archive", "e", "e"],
		["notes.pin", "p", "p"],
		["notes.favorite", "f", "f"],
		["notes.search", "mod+f", "mod+f"],
		["notes.import", "mod+o", "mod+o"],
		["notes.newTag", "shift+n", "shift+n"],
		["notes.restore", "", ""],
		["notes.export", "", ""],
		["notes.history", "", ""],
		["notes.participants", "", ""],
		["notes.exportAll", "", ""],
		["notes.toggleView", "", ""]
	])("%s ships %j off a Mac and %j on one", (id, other, mac) => {
		expect(defaultComboOn(defFor(id), OTHER)).toBe(other)
		expect(defaultComboOn(defFor(id), MAC)).toBe(mac)
	})

	it("resolves a registered default and applies a user's override", async () => {
		vi.resetModules()

		const { registerAction, comboFor, setUserCombo } = await import("@/lib/keymap/registry")

		registerAction(defFor("notes.rename"))
		registerAction(defFor("notes.archive"))

		expect(comboFor("notes.rename")).toBe("f2")

		await setUserCombo("notes.archive", "shift+e")

		expect(comboFor("notes.archive")).toBe("shift+e")
		expect(comboFor("notes.rename")).toBe("f2")
	})
})

describe("availableNoteAction — one gate for the menu and the shortcuts", () => {
	it("runs what the owner's menu offers", () => {
		const note = mockNote({ ownerId: 1n })

		expect(availableNoteAction(note, "archive", 1n, true, false)?.id).toBe("archive")
		expect(availableNoteAction(note, "rename", 1n, true, false)).toMatchObject({ run: "dialog", dialogKind: "rename" })
	})

	it("stands down where the menu would show the entry disabled: offline, or while the note's edits are queued", () => {
		const note = mockNote({ ownerId: 1n })

		expect(availableNoteAction(note, "archive", 1n, false, false)).toBeUndefined()
		expect(availableNoteAction(note, "pin", 1n, true, true)).toBeUndefined()
		// Export is a read: the offline gate leaves it on.
		expect(availableNoteAction(note, "export", 1n, false, false)?.id).toBe("export")
	})

	it("never runs what the menu does not offer", () => {
		expect(availableNoteAction(mockNote({ ownerId: 1n }), "deletePermanently", 1n, true, false)).toBeUndefined()
		expect(availableNoteAction(mockNote({ ownerId: 1n, trash: true }), "archive", 1n, true, false)).toBeUndefined()
		// Archive and trash are the owner's.
		expect(availableNoteAction(mockNote({ ownerId: 1n }), "archive", 2n, true, false)).toBeUndefined()
		expect(availableNoteAction(mockNote({ ownerId: 1n }), "trash", 2n, true, false)).toBeUndefined()
	})

	it("offers a trashed note's Delete permanently as its confirm dialog", () => {
		expect(availableNoteAction(mockNote({ ownerId: 1n, trash: true }), "deletePermanently", 1n, true, false)).toMatchObject({
			run: "dialog",
			dialogKind: "delete"
		})
	})
})

describe("notesRowKeyTarget", () => {
	const tag = mockNoteTag()
	const rows: NotesSidebarRow[] = [
		{ kind: "header", id: "h", label: { kind: "literal", text: "Today" }, icon: "today" },
		{ kind: "tag", tag, noteCount: 1, expanded: true },
		{ kind: "note", note: mockNote(), tagUuid: tag.uuid },
		{ kind: "header", id: "h2", label: { kind: "literal", text: "Older" }, icon: "calendar" },
		{ kind: "tag", tag: mockNoteTag(), noteCount: 0, expanded: false }
	]

	it("steps over headers and stops at the ends", () => {
		expect(notesRowKeyTarget(rows, 2, "ArrowDown")).toEqual({ kind: "focus", index: 4 })
		expect(notesRowKeyTarget(rows, 1, "ArrowUp")).toBeNull()
		expect(notesRowKeyTarget(rows, 4, "ArrowDown")).toBeNull()
		expect(notesRowKeyTarget(rows, 4, "Home")).toEqual({ kind: "focus", index: 1 })
		expect(notesRowKeyTarget(rows, 1, "End")).toEqual({ kind: "focus", index: 4 })
	})

	it("folds tags with Left and Right, and goes up from a note to its tag", () => {
		expect(notesRowKeyTarget(rows, 1, "ArrowLeft")).toEqual({ kind: "toggleTag" })
		expect(notesRowKeyTarget(rows, 1, "ArrowRight")).toBeNull()
		expect(notesRowKeyTarget(rows, 4, "ArrowRight")).toEqual({ kind: "toggleTag" })
		expect(notesRowKeyTarget(rows, 2, "ArrowLeft")).toEqual({ kind: "focus", index: 1 })
		expect(notesRowKeyTarget(rows, 2, "Enter")).toBeNull()
	})
})

describe("the focused-row guard", () => {
	function keydown(target: Element): KeyboardEvent {
		const event = new KeyboardEvent("keydown", { key: "e", code: "KeyE", bubbles: true })

		Object.defineProperty(event, "target", { value: target })

		return event
	}

	it("lets a single key through only from inside a note's row", () => {
		document.body.innerHTML = '<div data-note-uuid="n1"><a href="#" id="link">Note</a></div><button id="elsewhere">x</button>'

		const link = document.getElementById("link")
		const elsewhere = document.getElementById("elsewhere")

		if (link === null || elsewhere === null) {
			throw new Error("fixture missing")
		}

		expect(rowNoteUuid(link)).toBe("n1")
		expect(rowNoteUuid(elsewhere)).toBeUndefined()
		expect(ignoredOffNoteRow(keydown(link))).toBe(false)
		expect(ignoredOffNoteRow(keydown(elsewhere))).toBe(true)
	})

	it("stands down under an open dialog even on a row", () => {
		document.body.innerHTML = '<div data-note-uuid="n1"><a href="#" id="link">Note</a></div><div role="dialog" data-open></div>'

		const link = document.getElementById("link")

		if (link === null) {
			throw new Error("fixture missing")
		}

		expect(ignoredOffNoteRow(keydown(link))).toBe(true)
	})
})
