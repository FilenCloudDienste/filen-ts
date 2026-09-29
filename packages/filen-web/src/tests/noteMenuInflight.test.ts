// @vitest-environment jsdom

// The per-note menu (a sidebar row's, as much as the editor header's) must hold every action while that
// note's own edits are still queued: the content cache and the server copy both predate them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Note } from "@filen/sdk-rs"
import "@/lib/i18n"

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

const { NoteDropdownMenuContent } = await import("@/features/notes/components/noteMenu")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { useNotesInflightStore } = await import("@/features/notes/store/useNotesInflight")

const note: Note = {
	uuid: "note-0000-0000-0000-000000000000",
	ownerId: 1n,
	lastEditorId: 1n,
	favorite: false,
	pinned: false,
	tags: [],
	noteType: "text",
	encryptionKey: "note-key",
	title: "title",
	preview: "",
	trash: false,
	archive: false,
	createdTimestamp: 0n,
	editedTimestamp: 0n,
	participants: []
}

function renderOpenMenu(): void {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(NoteDropdownMenuContent, {
				note,
				allTags: [],
				currentUserId: 1n,
				onAction: () => undefined
			})
		)
	)
}

function disabledStates(): boolean[] {
	return screen.getAllByRole("menuitem").map(item => item.getAttribute("aria-disabled") === "true")
}

beforeEach(() => {
	useNotesInflightStore.setState({ inflightContent: {} })
})

afterEach(() => {
	cleanup()
})

describe("NoteDropdownMenuContent — queued edits", () => {
	it("offers the note's actions once its edits have synced", () => {
		renderOpenMenu()

		expect(disabledStates()).toContain(false)
	})

	it("disables every action while the note's edits are queued", () => {
		useNotesInflightStore.setState({
			inflightContent: { [note.uuid]: [{ content: "typed", timestamp: 0, note }] }
		})
		renderOpenMenu()

		const states = disabledStates()

		expect(states.length).toBeGreaterThan(0)
		expect(states.every(Boolean)).toBe(true)
	})
})
