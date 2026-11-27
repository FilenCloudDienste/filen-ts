// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Note } from "@filen/sdk-rs"
import "@/lib/i18n"

// The note row's Link is the only router surface these rows touch; stubbed down to the anchor it
// renders so a row can mount without a router context. `_params` is destructured purely to keep the
// router's own param object off the plain <a> the rest spread lands on.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, params: _params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode }) =>
		createElement("a", { ...rest, href: to }, children),
	useNavigate: () => () => undefined,
	useRouterState: () => ""
}))

import { NoteRow, type NoteRowProps } from "@/features/notes/components/noteRow"
import { touchLongPress, touchTap } from "@/tests/support/touch"
import { TagGroupRow } from "@/features/notes/components/notesSidebar"
import { mockNote, mockNoteParticipant, mockNoteTag } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"
import { notes as EN_NOTES } from "@/locales/en/notes"
import { formatClockTime, formatShortWeekday } from "@/lib/formatDate"

const NOW = 1_700_000_040_000
const DAY_MS = 24 * 60 * 60 * 1000

function renderNoteRow(
	selected: boolean,
	multiSelected: boolean,
	note: Note = mockNote(),
	handlers: Partial<
		Pick<
			NoteRowProps,
			"onPointerSelect" | "onLongPress" | "now" | "isOnline" | "inflight" | "saveFailed" | "nested" | "defaultNoteType"
		>
	> = {}
) {
	return render(
		createElement(NoteRow, {
			note,
			selected,
			multiSelected,
			allTags: [],
			currentUserId: 1n,
			now: NOW,
			isOnline: true,
			inflight: false,
			saveFailed: false,
			defaultNoteType: "text",
			onAction: () => undefined,
			onDuplicated: () => undefined,
			onPointerSelect: () => false,
			onLongPress: () => undefined,
			...handlers
		})
	)
}

function renderTagRow(expanded: boolean) {
	return render(
		createElement(TagGroupRow, {
			row: { kind: "tag", tag: mockNoteTag({ name: "Recipes" }), noteCount: 2, expanded },
			onToggle: () => undefined,
			onTagAction: () => undefined,
			onCreateNoteInTag: () => undefined
		})
	)
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
	const button = container.querySelector("button")

	if (!button) {
		throw new Error("no tag toggle rendered")
	}

	return button
}

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

// Deliberately NOT the ARIA tree/listbox patterns: both owe a roving-tabindex/arrow-key focus model
// the sidebar does not implement, and one flat virtualizer cannot nest DOM levels to back a hierarchy
// claim either (see notesSidebar.tsx's own note, and the drive sidebar's matching one).
describe("notes sidebar rows — list + disclosure semantics", () => {
	it("renders a note row without tree/listbox roles or a level it cannot back up", () => {
		const { container } = renderNoteRow(false, true)

		expect(container.querySelectorAll('[role="tree"], [role="treeitem"], [role="listbox"], [role="option"]')).toHaveLength(0)
		expect(container.querySelectorAll("[aria-level], [aria-selected]")).toHaveLength(0)
	})

	it("marks only the routed note as the current page, on the link that navigates to it", () => {
		const routed = renderNoteRow(true, false)

		expect(routed.container.querySelector("a")?.getAttribute("aria-current")).toBe("page")

		cleanup()

		const other = renderNoteRow(false, true)

		expect(other.container.querySelector("a")?.hasAttribute("aria-current")).toBe(false)
	})

	it("keeps the tag toggle a plain button — a role override would hide it from every button lookup", () => {
		const { container } = renderTagRow(false)

		expect(toggleOf(container).hasAttribute("role")).toBe(false)
	})

	it("carries the tag group's disclosure state, and its name, on that same button", () => {
		const collapsed = renderTagRow(false)

		expect(toggleOf(collapsed.container).getAttribute("aria-expanded")).toBe("false")
		expect(toggleOf(collapsed.container).getAttribute("aria-label")).toBe("Expand Recipes")

		cleanup()

		const expanded = renderTagRow(true)

		expect(toggleOf(expanded.container).getAttribute("aria-expanded")).toBe("true")
		expect(toggleOf(expanded.container).getAttribute("aria-label")).toBe("Collapse Recipes")
	})
})

describe("note row — calm layout", () => {
	function rowOf(container: HTMLElement): HTMLElement {
		const row = container.querySelector<HTMLElement>("[data-note-uuid]")

		if (!row) {
			throw new Error("no note row rendered")
		}

		return row
	}

	it("puts the edited time and the preview on one line, following the clock tick passed in", () => {
		const note = mockNote({ preview: "ship the editor", editedTimestamp: BigInt(NOW - 60_000) })
		const { container, rerender } = renderNoteRow(false, false, note)
		const meta = (): string => container.querySelector("a")?.children[1]?.textContent ?? ""

		expect(meta()).toBe(`${formatClockTime(NOW - 60_000)} · ship the editor`)

		rerender(
			createElement(NoteRow, {
				note,
				selected: false,
				multiSelected: false,
				allTags: [],
				currentUserId: 1n,
				now: NOW + 2 * DAY_MS,
				isOnline: true,
				inflight: false,
				saveFailed: false,
				defaultNoteType: "text",
				onAction: () => undefined,
				onDuplicated: () => undefined,
				onPointerSelect: () => false,
				onLongPress: () => undefined
			})
		)

		expect(meta()).toBe(`${formatShortWeekday(NOW - 60_000)} · ship the editor`)
	})

	it("shows at most two tag chips plus a count of the rest", () => {
		const tags = ["a", "b", "c", "d"].map(name => mockNoteTag({ uuid: testUuid(name), name }))
		renderNoteRow(false, false, mockNote({ tags }))

		expect(screen.getByText("a")).toBeTruthy()
		expect(screen.getByText("b")).toBeTruthy()
		expect(screen.queryByText("c")).toBeNull()
		expect(screen.getByText("+2")).toBeTruthy()
		// The hidden names stay in the link's accessible text.
		expect(screen.getByText("c, d").className).toContain("sr-only")
	})

	it("creates the hidden-tags tooltip only while the pointer is on the chip", () => {
		const tags = ["a", "b", "c", "d"].map(name => mockNoteTag({ uuid: testUuid(name), name }))
		renderNoteRow(false, false, mockNote({ tags }))
		const chip = screen.getByText("+2")

		expect(document.querySelector("[data-slot='tooltip-content']")).toBeNull()

		fireEvent.pointerEnter(chip)

		expect(document.querySelector("[data-slot='tooltip-content']")?.textContent).toBe("c, d")

		fireEvent.pointerLeave(screen.getByText("+2"))

		expect(document.querySelector("[data-slot='tooltip-content']")).toBeNull()
	})

	it("marks every type but the user's default one", () => {
		const plain = renderNoteRow(false, false, mockNote({ noteType: "text" }))

		expect(plain.container.querySelector("a svg")).toBeNull()

		cleanup()

		const checklist = renderNoteRow(false, false, mockNote({ noteType: "checklist" }))

		expect(checklist.container.querySelector("a svg")).not.toBeNull()

		cleanup()

		const defaultChecklist = renderNoteRow(false, false, mockNote({ noteType: "checklist" }), { defaultNoteType: "checklist" })

		expect(defaultChecklist.container.querySelector("a svg")).toBeNull()
	})

	it("folds who shared the note and who else is on it into one mark", () => {
		const note = mockNote({
			ownerId: 5n,
			participants: [
				mockNoteParticipant({ userId: 5n, isOwner: true, email: "owner@example.com", nickName: "" }),
				mockNoteParticipant({ userId: 1n }),
				mockNoteParticipant({ userId: 7n, nickName: "Bob" })
			]
		})
		const { container } = renderNoteRow(false, false, note)

		const label = "Shared by owner@example.com\nShared with Bob"
		const accessible = container.querySelector("a .sr-only")

		expect(accessible?.textContent).toBe(label)

		fireEvent.pointerEnter(accessible?.parentElement ?? container)

		expect(document.querySelector("[data-slot='tooltip-content']")?.textContent).toBe(label)
	})

	it("exposes pin and favorite as toggles carrying their state, disabled offline", () => {
		const { container } = renderNoteRow(false, false, mockNote({ pinned: true }), { isOnline: false })
		const pin = rowOf(container).querySelector('[aria-label="Pinned"]')
		const favorite = rowOf(container).querySelector('[aria-label="Favorite"]')

		expect(pin?.getAttribute("aria-pressed")).toBe("true")
		expect(favorite?.getAttribute("aria-pressed")).toBe("false")
		// Off but hoverable, so the tooltip can say why.
		expect(pin?.getAttribute("aria-disabled")).toBe("true")
		// Siblings of the link, never inside it.
		expect(container.querySelector("a [aria-pressed]")).toBeNull()
	})

	it("holds pin and favorite while the note's edits are queued, saying why as the menu does", () => {
		const { container } = renderNoteRow(false, false, mockNote({ pinned: true }), { inflight: true })
		const pin = rowOf(container).querySelector('[aria-label="Pinned"]')
		const favorite = rowOf(container).querySelector('[aria-label="Favorite"]')

		expect(pin?.getAttribute("aria-disabled")).toBe("true")
		expect(favorite?.getAttribute("aria-disabled")).toBe("true")
		expect(document.getElementById(pin?.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Saving…")

		cleanup()

		const idle = renderNoteRow(false, false, mockNote({ pinned: true }))

		expect(rowOf(idle.container).querySelector('[aria-label="Pinned"]')?.hasAttribute("aria-disabled")).toBe(false)
	})

	it("keeps clicks, presses and right-clicks on a row's tooltip from reaching the row", () => {
		const onPointerSelect = vi.fn(() => false)
		const tags = ["a", "b", "c", "d"].map(name => mockNoteTag({ uuid: testUuid(name), name }))
		renderNoteRow(false, false, mockNote({ tags }), { onPointerSelect })

		fireEvent.pointerEnter(screen.getByText("+2"))

		const popup = document.querySelector("[data-slot='tooltip-content']")

		expect(popup).not.toBeNull()

		if (popup === null) {
			return
		}

		fireEvent.pointerDown(popup)
		fireEvent.click(popup)
		fireEvent.contextMenu(popup)

		expect(onPointerSelect).not.toHaveBeenCalled()
		expect(screen.queryByRole("menu")).toBeNull()

		// The row's own link still takes its clicks.
		fireEvent.click(screen.getByText("+2"))

		expect(onPointerSelect).toHaveBeenCalledOnce()
	})

	it("keeps a trashed note's pin as a plain mark, since its menu offers no pin", () => {
		const { container } = renderNoteRow(false, false, mockNote({ pinned: true, trash: true }))

		expect(container.querySelector("[aria-pressed]")).toBeNull()
		expect(container.querySelector('[role="img"][aria-label="Pinned"]')).not.toBeNull()
	})
})

describe("note row — touch", () => {
	function link(container: HTMLElement): HTMLAnchorElement {
		const anchor = container.querySelector("a")

		if (!anchor) {
			throw new Error("no note link rendered")
		}

		return anchor
	}

	it("reports a tap as touch and navigates unless the tap was taken as a selection gesture", () => {
		let gesture = false
		const onPointerSelect = vi.fn<NoteRowProps["onPointerSelect"]>(() => gesture)
		const { container } = renderNoteRow(false, false, mockNote(), { onPointerSelect })

		expect(touchTap(link(container))).toBe(true)
		gesture = true
		expect(touchTap(link(container))).toBe(false)
		expect(onPointerSelect.mock.calls.map(call => call[1])).toEqual(["touch", "touch"])
	})

	it("toggles on a long-press, opening no menu and swallowing the click that ends it", () => {
		vi.useFakeTimers()

		const onPointerSelect = vi.fn<NoteRowProps["onPointerSelect"]>(() => false)
		const onLongPress = vi.fn()
		const { container } = renderNoteRow(false, false, mockNote(), { onPointerSelect, onLongPress })

		expect(touchLongPress(link(container))).toBe(false)
		expect(onLongPress).toHaveBeenCalledOnce()
		expect(onPointerSelect).not.toHaveBeenCalled()
		expect(screen.queryByRole("menu")).toBeNull()
	})
})

describe("NoteRow sync state", () => {
	it("shows the editor header's syncing spinner while the note's edit is queued", () => {
		renderNoteRow(false, false, mockNote(), { inflight: true })

		expect(screen.getByLabelText(EN_NOTES.noteSyncing)).toBeDefined()
	})

	it("shows the not-saved warning instead once the queued edit failed", () => {
		renderNoteRow(false, false, mockNote(), { inflight: true, saveFailed: true })

		expect(screen.getByText(EN_NOTES.noteSaveFailedRetrying)).toBeDefined()
		expect(screen.queryByLabelText(EN_NOTES.noteSyncing)).toBeNull()
	})

	it("shows neither while nothing is queued", () => {
		renderNoteRow(false, false, mockNote())

		expect(screen.queryByLabelText(EN_NOTES.noteSyncing)).toBeNull()
		expect(screen.queryByText(EN_NOTES.noteSaveFailedRetrying)).toBeNull()
	})
})
