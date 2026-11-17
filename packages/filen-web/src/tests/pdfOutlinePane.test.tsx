// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PdfOutlineItem } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { PdfOutlinePane } from "@/features/preview/components/pdfOutlinePane"
import { mockViewportHeight } from "@/tests/support/viewport"
import "@/lib/i18n"

// The outline pane over a stand-in document whose destinations are page indexes: keys, the current section, and only
// the rows near the view resolved.

const { resolveDestination } = vi.hoisted(() => ({
	resolveDestination: vi.fn((_document: unknown, dest: readonly unknown[]) =>
		Promise.resolve({ page: (dest[0] as number) + 1, left: null, top: null })
	)
}))

vi.mock("@filen/office/dom/pdf", async importOriginal => ({ ...(await importOriginal<object>()), resolveDestination }))
vi.mock("@filen/shared/dom/scheduleIdle", () => ({
	scheduleIdle: (run: () => void) => {
		queueMicrotask(run)

		return () => undefined
	}
}))

afterEach(() => {
	cleanup()
	resolveDestination.mockClear()
})

const DOCUMENT = { numPages: 1000 } as unknown as PdfDomDocument

function outline(count: number): PdfOutlineItem[] {
	return Array.from({ length: count }, (_, index) => ({ title: `Chapter ${String(index)}`, depth: index % 2, dest: [index] }))
}

async function settle(): Promise<void> {
	for (let round = 0; round < 50; round++) await act(() => Promise.resolve())
}

describe("PdfOutlinePane", () => {
	it("resolves only the rows near the view, marks the current section and goes with Enter", async () => {
		mockViewportHeight(element => element.getAttribute("role") === "tree", 280)

		const onGo = vi.fn()

		render(
			<PdfOutlinePane
				document={DOCUMENT}
				outline={outline(500)}
				page={4}
				onGo={onGo}
			/>
		)
		await settle()

		const asked = new Set(resolveDestination.mock.calls.map(([, dest]) => dest[0] as number))

		expect(asked.size).toBeGreaterThan(0)
		expect(Math.max(...asked)).toBeLessThan(60)
		expect(screen.getByRole("treeitem", { current: "location" }).textContent).toContain("Chapter 3")

		const tree = screen.getByRole("tree")

		act(() => {
			screen.getAllByRole("treeitem")[0]?.focus()
		})
		fireEvent.keyDown(tree, { key: "ArrowDown" })
		await settle()
		expect(document.activeElement?.textContent).toContain("Chapter 1")

		fireEvent.keyDown(tree, { key: "Enter" })
		await settle()
		expect(onGo).toHaveBeenCalledWith({ page: 2, left: null, top: null })
	})

	it("collapses with the left key, and closes from its button", async () => {
		mockViewportHeight(element => element.getAttribute("role") === "tree", 280)

		const onClose = vi.fn()
		const items: PdfOutlineItem[] = [
			{ title: "Part", depth: 0, dest: [0] },
			{ title: "Section", depth: 1, dest: [1] },
			{ title: "Next", depth: 0, dest: [2] }
		]

		render(
			<PdfOutlinePane
				document={DOCUMENT}
				outline={items}
				page={1}
				onGo={vi.fn()}
				onClose={onClose}
			/>
		)
		await settle()

		const part = screen.getByRole("treeitem", { name: /Part/u })

		expect(part.getAttribute("aria-expanded")).toBe("true")
		act(() => {
			part.focus()
		})
		fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" })
		expect(screen.queryByText("Section")).toBeNull()
		expect(screen.getByRole("treeitem", { name: /Part/u }).getAttribute("aria-expanded")).toBe("false")

		fireEvent.click(screen.getByRole("button", { name: "Close outline" }))
		expect(onClose).toHaveBeenCalledOnce()
	})

	it("resolves a new document's outline again, even after the previous outline was shown against it", async () => {
		mockViewportHeight(element => element.getAttribute("role") === "tree", 280)

		const before = outline(3)
		const relaid = { numPages: 1000 } as unknown as PdfDomDocument
		// The relaid book's outline: the same rows, other pages.
		const after = before.map(item => ({ ...item, dest: [((item.dest as number[])[0] ?? 0) + 10] }))
		const view = render(
			<PdfOutlinePane
				document={DOCUMENT}
				outline={before}
				page={1}
				onGo={vi.fn()}
			/>
		)

		await settle()
		// The host pairs the new document with the old outline until the new one is read.
		view.rerender(
			<PdfOutlinePane
				document={relaid}
				outline={before}
				page={12}
				onGo={vi.fn()}
			/>
		)
		await settle()
		view.rerender(
			<PdfOutlinePane
				document={relaid}
				outline={after}
				page={12}
				onGo={vi.fn()}
			/>
		)
		await settle()

		// Chapter 1 now starts on page 12: the current section follows the new outline.
		expect(screen.getByRole("treeitem", { current: "location" }).textContent).toContain("Chapter 1")
	})

	it("states each row's place among its siblings, and keeps the tree in the tab order when the focused row scrolls away", async () => {
		mockViewportHeight(element => element.getAttribute("role") === "tree", 280)
		render(
			<PdfOutlinePane
				document={DOCUMENT}
				outline={outline(500)}
				page={1}
				onGo={vi.fn()}
			/>
		)
		await settle()

		const tree = screen.getByRole("tree")
		const rows = screen.getAllByRole("treeitem")

		// Depths alternate 0, 1, 0, 1...: 250 top-level items, each with one child.
		expect([rows[0]?.getAttribute("aria-posinset"), rows[0]?.getAttribute("aria-setsize")]).toEqual(["1", "250"])
		expect([rows[1]?.getAttribute("aria-posinset"), rows[1]?.getAttribute("aria-setsize")]).toEqual(["1", "1"])
		expect([rows[2]?.getAttribute("aria-posinset"), rows[2]?.getAttribute("aria-setsize")]).toEqual(["2", "250"])
		expect(tree.tabIndex).toBe(-1)
		expect(rows[0]?.tabIndex).toBe(0)

		// Scrolled far down: the focused first row is no longer rendered.
		tree.scrollTop = 5000
		fireEvent.scroll(tree)
		await settle()
		expect(screen.queryByText("Chapter 0")).toBeNull()
		expect(tree.tabIndex).toBe(0)

		act(() => {
			tree.focus()
		})
		await settle()
		expect(document.activeElement?.getAttribute("role")).toBe("treeitem")
	})
})
