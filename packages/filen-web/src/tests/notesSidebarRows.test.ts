// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, act, screen } from "@testing-library/react"
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
import { mockNote, mockNoteTag } from "@/tests/fixtures/notes"

function renderNoteRow(
	selected: boolean,
	multiSelected: boolean,
	note: Note = mockNote(),
	handlers: Partial<Pick<NoteRowProps, "onPointerSelect" | "onLongPress">> = {}
) {
	return render(
		createElement(NoteRow, {
			note,
			selected,
			multiSelected,
			allTags: [],
			currentUserId: 1n,
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

describe("note row — relative edited time", () => {
	it("follows the shared minute tick while the row stays mounted", () => {
		// Minute-aligned, so the tick lands exactly on the labels asserted below.
		const base = 1_700_000_040_000

		vi.useFakeTimers()
		vi.setSystemTime(base)

		renderNoteRow(false, false, { ...mockNote(), editedTimestamp: BigInt(base) })

		expect(screen.getByText("Just now")).toBeTruthy()

		act(() => {
			vi.advanceTimersByTime(5 * 60_000)
		})

		expect(screen.getByText("5 minutes ago")).toBeTruthy()
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
