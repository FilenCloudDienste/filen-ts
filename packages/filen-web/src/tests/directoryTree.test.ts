// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import "@/lib/i18n"

// The only mock the tree needs: the drop hook reaches into the SDK action surface, and drag-to-move
// is not what these role assertions are about. Everything else is injected through DirectoryTreeContext.
vi.mock("@/features/drive/hooks/useDriveDropTarget", () => ({
	useDriveDropTarget: () => ({
		isOver: false,
		onDragEnter: () => undefined,
		onDragOver: () => undefined,
		onDragLeave: () => undefined,
		onDrop: () => undefined
	})
}))

import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import type { DirectoryTreeChild } from "@/features/drive/queries/drive"

function child(uuid: string, name: string): DirectoryTreeChild {
	return { uuid, name, color: "default" }
}

// Two levels: "docs" holds "invoices"; "photos" is a leaf sibling of "docs".
const CHILDREN: Record<string, DirectoryTreeChild[]> = {
	root: [child("docs", "Docs"), child("photos", "Photos")],
	docs: [child("invoices", "Invoices")]
}

function resolved(data: DirectoryTreeChild[]): UseQueryResult<DirectoryTreeChild[]> {
	return { status: "success", data } as UseQueryResult<DirectoryTreeChild[]>
}

function pending(): UseQueryResult<DirectoryTreeChild[]> {
	return { status: "pending" } as UseQueryResult<DirectoryTreeChild[]>
}

function renderTree(overrides: Partial<DirectoryTreeContext> = {}) {
	const tree: DirectoryTreeContext = {
		activePath: [],
		isOpen: uuid => uuid === "docs",
		onToggle: () => undefined,
		onNavigate: () => undefined,
		useChildren: uuid => resolved(CHILDREN[uuid ?? "root"] ?? []),
		...overrides
	}

	return render(createElement(DirectoryTree, { tree }))
}

function chevronFor(container: HTMLElement, name: string): Element {
	const chevron = rowFor(container, name).querySelector("button")

	if (!chevron) {
		throw new Error(`no chevron rendering "${name}"`)
	}

	return chevron
}

function rowFor(container: HTMLElement, name: string): Element {
	for (const item of container.querySelectorAll("li")) {
		// The row div is the item's FIRST child; a nested subtree's own items live below it.
		const row = item.firstElementChild

		if (row !== null && row.textContent.includes(name) && row.querySelector("li") === null) {
			return row
		}
	}

	throw new Error(`no row rendering "${name}"`)
}

afterEach(() => {
	cleanup()
})

// Deliberately NOT the ARIA tree pattern: without a roving-tabindex/arrow-key focus model, role="tree"
// would promise an interaction contract this widget does not honour (see directoryTree.tsx's header).
describe("DirectoryTree — list + disclosure semantics", () => {
	it("renders plain nested lists, never tree roles it cannot back up", () => {
		const { container } = renderTree()

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0)
		expect(container.querySelectorAll('[role="tree"], [role="group"]')).toHaveLength(0)
		expect(container.querySelectorAll("li")).toHaveLength(3)
	})

	it("nests an open node's subtree inside that node's own list item", () => {
		const { container } = renderTree()

		const docs = container.querySelector("li")

		expect(docs?.querySelectorAll("li")).toHaveLength(1)
	})

	it("carries the disclosure state on the chevron that toggles it", () => {
		const { container } = renderTree()

		expect(chevronFor(container, "Docs").getAttribute("aria-expanded")).toBe("true")
		expect(chevronFor(container, "Photos").getAttribute("aria-expanded")).toBe("false")
	})

	it("names each row's chevron without also naming the row twice over", () => {
		const { container } = renderTree()

		expect(chevronFor(container, "Docs").getAttribute("aria-label")).toBe("Collapse Docs")
		expect(rowFor(container, "Docs").hasAttribute("aria-label")).toBe(false)
	})

	it("marks only the node matching activePath as the current page", () => {
		const { container } = renderTree({ activePath: ["docs"] })

		const navButtons = (name: string) => rowFor(container, name).querySelectorAll("button")[1]

		expect(navButtons("Docs")?.getAttribute("aria-current")).toBe("page")
		expect(navButtons("Photos")?.hasAttribute("aria-current")).toBe(false)
	})

	it("renders the loading level as presentational — a pending fetch is not a list item", () => {
		const { container } = renderTree({ isOpen: () => false, useChildren: () => pending() })

		expect(container.querySelector('[role="presentation"]')).not.toBeNull()
	})
})
