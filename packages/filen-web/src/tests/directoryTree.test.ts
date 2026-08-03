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

function nodeNamed(container: HTMLElement, name: string): Element {
	for (const node of container.querySelectorAll('[role="treeitem"]')) {
		if (node.textContent.includes(name)) {
			return node
		}
	}

	throw new Error(`no treeitem rendering "${name}"`)
}

afterEach(() => {
	cleanup()
})

describe("DirectoryTree — tree semantics", () => {
	it("renders every level as a group of treeitem rows", () => {
		const { container } = renderTree()

		expect(container.querySelectorAll('[role="group"]').length).toBeGreaterThanOrEqual(2)
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
	})

	it("starts at level 2 (the owning surface renders the root at level 1) and deepens with the subtree", () => {
		const { container } = renderTree()

		expect(nodeNamed(container, "Docs").getAttribute("aria-level")).toBe("2")
		expect(nodeNamed(container, "Invoices").getAttribute("aria-level")).toBe("3")
	})

	it("reports each node's position among its own siblings, not among everything mounted", () => {
		const { container } = renderTree()

		const docs = nodeNamed(container, "Docs")
		const photos = nodeNamed(container, "Photos")
		const invoices = nodeNamed(container, "Invoices")

		expect([docs.getAttribute("aria-posinset"), docs.getAttribute("aria-setsize")]).toStrictEqual(["1", "2"])
		expect([photos.getAttribute("aria-posinset"), photos.getAttribute("aria-setsize")]).toStrictEqual(["2", "2"])
		expect([invoices.getAttribute("aria-posinset"), invoices.getAttribute("aria-setsize")]).toStrictEqual(["1", "1"])
	})

	it("carries the expanded state on the node itself, never also on the chevron", () => {
		const { container } = renderTree()

		expect(nodeNamed(container, "Docs").getAttribute("aria-expanded")).toBe("true")
		expect(nodeNamed(container, "Photos").getAttribute("aria-expanded")).toBe("false")

		for (const button of container.querySelectorAll("button")) {
			expect(button.hasAttribute("aria-expanded")).toBe(false)
		}
	})

	it("marks only the node matching activePath as selected", () => {
		const { container } = renderTree({ activePath: ["docs"] })

		expect(nodeNamed(container, "Docs").getAttribute("aria-selected")).toBe("true")
		expect(nodeNamed(container, "Photos").getAttribute("aria-selected")).toBe("false")
	})

	it("renders the loading level as presentational — a pending fetch is not a tree node", () => {
		const { container } = renderTree({ isOpen: () => false, useChildren: () => pending() })

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0)
		expect(container.querySelector('[role="presentation"]')).not.toBeNull()
	})
})
