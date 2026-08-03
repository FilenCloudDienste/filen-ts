// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// Both rows pull the SDK action surface in transitively (their menus), and the real client module
// imports a Vite `?worker` — unresolvable under vitest, and no assertion here dispatches an action.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

// The note row's Link is the only router surface these rows touch; stubbed down to the anchor it
// renders so a row can mount without a router context. `_params` is destructured purely to keep the
// router's own param object off the plain <a> the rest spread lands on.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, params: _params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode }) =>
		createElement("a", { ...rest, href: to }, children),
	useNavigate: () => () => undefined,
	useRouterState: () => ""
}))

import { NoteRow } from "@/features/notes/components/noteRow"
import { TagGroupRow } from "@/features/notes/components/notesSidebar"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: []
	}
}

function mockTag(): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "Recipes",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n
	}
}

function renderNoteRow(selected: boolean, multiSelected: boolean) {
	return render(
		createElement(NoteRow, {
			note: mockNote(),
			selected,
			multiSelected,
			allTags: [],
			currentUserId: 1n,
			onAction: () => undefined,
			onDuplicated: () => undefined,
			onPointerSelect: () => undefined
		})
	)
}

function renderTagRow(expanded: boolean) {
	return render(
		createElement(TagGroupRow, {
			row: { kind: "tag", tag: mockTag(), noteCount: 2, expanded },
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
