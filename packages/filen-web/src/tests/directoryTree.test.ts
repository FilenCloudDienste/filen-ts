// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

// Every open level, as the tree's one query hook hands them over: the levels the test sets, empty otherwise.
const fixture = vi.hoisted((): { levels: Record<string, DirectoryTreeLevel>; empty: DirectoryTreeLevel } => ({
	levels: {},
	empty: { status: "success", isFetching: false, data: [] }
}))

vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeLevelsQuery: (parents: readonly (string | null)[]) =>
		parents.map(parent => fixture.levels[parent ?? "root"] ?? fixture.empty),
	// The hook above hands every level over at once, as a held listing is: the cache holds the same.
	cachedDirectoryTreeChildren: (uuid: string) => fixture.levels[uuid]?.data
}))

// The drop hook reaches into the SDK action surface, and drag-to-move is not what these assertions are about
// (directoryTreeDnd.test.tsx covers it).
vi.mock("@/features/drive/hooks/useDriveDropTarget", () => ({
	dropHighlightClass: () => false,
	useDriveDropTarget: () => ({
		isOver: false,
		mode: "move",
		upload: false,
		attach: () => undefined,
		handlers: {
			onDragEnter: () => undefined,
			onDragOver: () => undefined,
			onDragLeave: () => undefined,
			onDrop: () => undefined
		}
	})
}))

import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import type { DirectoryTreeChild, DirectoryTreeLevel } from "@/features/drive/queries/drive"
import { sizedScrollArea } from "@/tests/support/viewport"

const VIEWPORT_HEIGHT = 340

function child(uuid: string, name: string): DirectoryTreeChild {
	return { uuid, name, color: "default" }
}

function resolved(data: DirectoryTreeChild[]): DirectoryTreeLevel {
	return { status: "success", isFetching: false, data }
}

const PENDING: DirectoryTreeLevel = { status: "pending", isFetching: true, data: undefined }

// "docs" holds "invoices" and "insurance"; "photos" is a leaf sibling of "docs".
const LEVELS: Record<string, DirectoryTreeLevel> = {
	root: resolved([child("docs", "Docs"), child("photos", "Photos")]),
	docs: resolved([child("invoices", "Invoices"), child("insurance", "Insurance")])
}

function context(overrides: Partial<DirectoryTreeContext> = {}): DirectoryTreeContext {
	return {
		activePath: [],
		isOpen: uuid => uuid === "docs",
		onToggle: () => undefined,
		onNavigate: () => undefined,
		...overrides
	}
}

function renderTree(overrides: Partial<DirectoryTreeContext> = {}, levels: Record<string, DirectoryTreeLevel> = LEVELS) {
	fixture.levels = levels

	const scrollElement = sizedScrollArea(VIEWPORT_HEIGHT)

	return render(createElement(DirectoryTree, { tree: context(overrides), scrollElement }))
}

function item(name: string): HTMLElement {
	return screen.getByRole("treeitem", { name })
}

function press(target: HTMLElement, key: string, init: Record<string, unknown> = {}): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })

	act(() => {
		target.dispatchEvent(event)
	})

	return event
}

// The virtualizer settles a scroll over the next frames.
async function frames(): Promise<void> {
	for (let frame = 0; frame < 3; frame++) {
		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
		})
	}
}

afterEach(() => {
	cleanup()
	document.body.replaceChildren()
})

describe("DirectoryTree — the ARIA tree pattern", () => {
	it("renders one labelled tree whose rows say where they sit, open nodes followed by their children", () => {
		renderTree()

		expect(screen.getByRole("tree", { name: "Directory tree" })).toBeTruthy()
		expect(screen.getAllByRole("treeitem").map(row => row.textContent)).toEqual(["Docs", "Invoices", "Insurance", "Photos"])
		expect(
			["Docs", "Insurance", "Photos"].map(name => {
				const row = item(name)

				return [row.getAttribute("aria-level"), row.getAttribute("aria-posinset"), row.getAttribute("aria-setsize")]
			})
		).toEqual([
			["1", "1", "2"],
			["2", "2", "2"],
			["1", "2", "2"]
		])
		expect(item("Docs").getAttribute("aria-expanded")).toBe("true")
		expect(item("Photos").getAttribute("aria-expanded")).toBe("false")
	})

	it("selects only the current directory, and makes it the one Tab stop", () => {
		renderTree({ activePath: ["docs", "invoices"] })

		expect(item("Invoices").getAttribute("aria-selected")).toBe("true")
		expect(item("Docs").getAttribute("aria-selected")).toBe("false")
		expect(screen.getAllByRole("treeitem").map(row => row.tabIndex)).toEqual([-1, 0, -1, -1])
	})

	it("puts the Tab stop on the first node when the current directory is not shown", () => {
		renderTree({ activePath: ["elsewhere"] })

		expect(screen.getAllByRole("treeitem").map(row => row.tabIndex)).toEqual([0, -1, -1, -1])
	})

	it("shows a loading level on its owner, adding no row and announcing nothing", () => {
		renderTree({}, { ...LEVELS, docs: PENDING })

		expect(item("Docs").getAttribute("aria-busy")).toBe("true")
		expect(item("Docs").querySelector('[data-slot="spinner"]')?.getAttribute("aria-hidden")).toBe("true")
		expect(item("Photos").hasAttribute("aria-busy")).toBe(false)
		expect(screen.getAllByRole("treeitem")).toHaveLength(2)
	})

	it("reports the root level's first load to its owner until it settles", () => {
		const onPendingChange = vi.fn()
		const scrollElement = sizedScrollArea(VIEWPORT_HEIGHT)
		fixture.levels = { root: PENDING }

		const tree = context()
		const { container, rerender } = render(createElement(DirectoryTree, { tree, scrollElement, onPendingChange }))

		expect(container.childElementCount).toBe(0)
		expect(onPendingChange.mock.calls).toEqual([[true]])

		fixture.levels = {}
		rerender(createElement(DirectoryTree, { tree: { ...tree }, scrollElement, onPendingChange }))

		expect(onPendingChange.mock.calls).toEqual([[true], [false]])
	})

	it("shows a level that failed as a line in its place that the keys pass over", () => {
		renderTree({}, { ...LEVELS, docs: { status: "error", isFetching: false, data: undefined } })

		expect(screen.getByText("Couldn't load this directory")).toBeTruthy()
		expect(screen.getAllByRole("treeitem")).toHaveLength(2)

		item("Docs").focus()
		press(item("Docs"), "ArrowDown")

		expect(document.activeElement).toBe(item("Photos"))
	})

	it("shows a failed root level as a plain line, not as an empty tree", () => {
		renderTree({}, { root: { status: "error", isFetching: false, data: undefined } })

		expect(screen.getByText("Couldn't load this directory").closest("[role]")).toBeNull()
		expect(screen.queryByRole("tree")).toBeNull()
	})

	it("toggles from a node's chevron with its parent, null at the top level, and opens a clicked node's path", () => {
		const onToggle = vi.fn()
		const onNavigate = vi.fn()

		renderTree({ onToggle, onNavigate })

		for (const name of ["Photos", "Invoices"]) {
			const chevron = item(name).querySelector("[data-tree-chevron]")

			if (chevron === null) {
				throw new Error(`no chevron on ${name}`)
			}

			fireEvent.click(chevron)
		}

		expect(onToggle.mock.calls).toEqual([
			["photos", null],
			["invoices", "docs"]
		])
		expect(onNavigate).not.toHaveBeenCalled()

		fireEvent.click(item("Insurance"))
		expect(onNavigate).toHaveBeenCalledExactlyOnceWith(["docs", "insurance"])
	})

	it("reports each level's children once its fetch settles, never while one is still running", () => {
		const onLevelLoaded = vi.fn()

		renderTree({ onLevelLoaded }, { ...LEVELS, docs: { status: "success", isFetching: true, data: LEVELS["docs"]?.data } })

		expect(onLevelLoaded.mock.calls).toEqual([[null, ["docs", "photos"]]])
	})
})

describe("DirectoryTree — keyboard", () => {
	it("moves focus with Up, Down, Home and End, keeping the keys from the page", () => {
		renderTree()
		item("Docs").focus()

		const down = press(item("Docs"), "ArrowDown")

		expect(down.defaultPrevented).toBe(true)
		expect(document.activeElement).toBe(item("Invoices"))

		press(item("Invoices"), "End")
		expect(document.activeElement).toBe(item("Photos"))

		press(item("Photos"), "ArrowDown")
		expect(document.activeElement).toBe(item("Photos"))

		press(item("Photos"), "ArrowUp")
		expect(document.activeElement).toBe(item("Insurance"))

		press(item("Insurance"), "Home")
		expect(document.activeElement).toBe(item("Docs"))
		// The Tab stop follows focus.
		expect(screen.getAllByRole("treeitem").map(row => row.tabIndex)).toEqual([0, -1, -1, -1])
	})

	it("opens a closed node with Right, and steps into an open one's first child", () => {
		const onToggle = vi.fn()

		renderTree({ onToggle })
		item("Photos").focus()
		press(item("Photos"), "ArrowRight")

		expect(onToggle).toHaveBeenCalledExactlyOnceWith("photos", null)

		item("Docs").focus()
		press(item("Docs"), "ArrowRight")

		expect(onToggle).toHaveBeenCalledOnce()
		expect(document.activeElement).toBe(item("Invoices"))
	})

	it("steps out to the parent with Left, and closes an open node", () => {
		const onToggle = vi.fn()

		renderTree({ onToggle })
		item("Insurance").focus()
		press(item("Insurance"), "ArrowLeft")

		expect(document.activeElement).toBe(item("Docs"))
		expect(onToggle).not.toHaveBeenCalled()

		press(item("Docs"), "ArrowLeft")
		expect(onToggle).toHaveBeenCalledExactlyOnceWith("docs", null)
	})

	it("opens the focused directory with Enter", () => {
		const onNavigate = vi.fn()
		const documentKeydown = vi.fn()

		document.addEventListener("keydown", documentKeydown)
		renderTree({ onNavigate })
		item("Invoices").focus()
		press(item("Invoices"), "Enter")
		document.removeEventListener("keydown", documentKeydown)

		expect(onNavigate).toHaveBeenCalledExactlyOnceWith(["docs", "invoices"])
		expect(documentKeydown).not.toHaveBeenCalled()
	})

	it("opens the focused directory with Space, which continues a type-ahead prefix instead", () => {
		const onNavigate = vi.fn()

		renderTree({ onNavigate })
		item("Invoices").focus()

		expect(press(item("Invoices"), " ").defaultPrevented).toBe(true)
		expect(onNavigate).toHaveBeenCalledExactlyOnceWith(["docs", "invoices"])

		onNavigate.mockClear()
		press(item("Invoices"), "p")
		expect(document.activeElement).toBe(item("Photos"))
		expect(press(item("Photos"), " ").defaultPrevented).toBe(true)
		expect(onNavigate).not.toHaveBeenCalled()
	})

	it("leaves a chord to its shortcut", () => {
		const onNavigate = vi.fn()

		renderTree({ onNavigate })
		item("Docs").focus()

		expect(press(item("Docs"), "ArrowDown", { altKey: true }).defaultPrevented).toBe(false)
		expect(press(item("Docs"), "Enter", { shiftKey: true }).defaultPrevented).toBe(false)
		expect(document.activeElement).toBe(item("Docs"))
		expect(onNavigate).not.toHaveBeenCalled()
	})

	it("moves to the next node whose name starts with what is typed", () => {
		renderTree()
		item("Docs").focus()

		press(item("Docs"), "i")
		expect(document.activeElement).toBe(item("Invoices"))

		press(item("Invoices"), "n")
		press(item("Invoices"), "s")
		expect(document.activeElement).toBe(item("Insurance"))
	})
})

describe("DirectoryTree — deep trees", () => {
	it("mounts a chain of 40 nested open directories whose listings are already held", () => {
		const DEPTH = 40
		const levels: Record<string, DirectoryTreeLevel> = { root: resolved([child("level-0", "Level 0")]) }

		for (let depth = 0; depth < DEPTH - 1; depth++) {
			levels[`level-${String(depth)}`] = resolved([child(`level-${String(depth + 1)}`, `Level ${String(depth + 1)}`)])
		}

		renderTree({ isOpen: () => true, activePath: ["level-0"] }, levels)

		expect(item("Level 0").getAttribute("aria-level")).toBe("1")
		expect(screen.getByRole("tree").style.height).toBe(`${String(DEPTH * 34 - 2)}px`)
	})
})

describe("DirectoryTree — virtualization", () => {
	const MANY = Array.from({ length: 20_000 }, (_, index) => child(`dir-${String(index)}`, `Directory ${String(index).padStart(5, "0")}`))

	it("mounts a window of a huge level, each row still saying its place in the whole", () => {
		renderTree({ isOpen: () => false }, { root: resolved(MANY) })

		const rows = screen.getAllByRole("treeitem")

		expect(rows.length).toBeGreaterThan(5)
		expect(rows.length).toBeLessThan(50)
		expect(rows[0]?.getAttribute("aria-setsize")).toBe("20000")
		expect(screen.getByRole("tree").style.height).toBe(`${String(20_000 * 34 - 2)}px`)
	})

	it("brings a node outside the window in with End, and keeps the Tab stop mounted wherever the window is", async () => {
		renderTree({ isOpen: () => false }, { root: resolved(MANY) })

		const first = item("Directory 00000")

		first.focus()
		press(first, "End")

		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
		})

		expect(document.activeElement).toBe(item("Directory 19999"))
		expect(screen.queryByRole("treeitem", { name: "Directory 00000" })?.tabIndex).toBe(-1)
		expect(item("Directory 19999").tabIndex).toBe(0)
		expect(screen.getAllByRole("treeitem").length).toBeLessThan(50)
	})

	it("scrolls the current directory's row into view when it becomes another one, not on every render", async () => {
		const scrollElement = sizedScrollArea(VIEWPORT_HEIGHT)
		// jsdom neither scrolls nor sizes the content.
		const scrollTo = vi.fn<(options: ScrollToOptions) => void>()

		Object.defineProperty(scrollElement, "scrollHeight", { configurable: true, value: 20_000 * 34 })
		Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo })

		const tree = context({ isOpen: () => false, activePath: ["dir-15000"] })
		const scrolledTo = () => scrollTo.mock.calls.map(([options]) => options.top)

		fixture.levels = { root: resolved(MANY) }

		const { rerender } = render(createElement(DirectoryTree, { tree, scrollElement }))

		await frames()
		expect(scrolledTo().at(-1)).toBe(15_000 * 34 + 32 - VIEWPORT_HEIGHT)
		expect(item("Directory 15000").getAttribute("aria-selected")).toBe("true")

		const calls = scrollTo.mock.calls.length

		rerender(createElement(DirectoryTree, { tree: { ...tree }, scrollElement }))
		await frames()
		expect(scrollTo.mock.calls.length).toBe(calls)

		rerender(createElement(DirectoryTree, { tree: { ...tree, activePath: ["dir-100"] }, scrollElement }))
		await frames()
		expect(scrollTo.mock.calls.length).toBeGreaterThan(calls)
	})

	it("scrolls the current directory's row into view once a scroll area that arrives later is supplied", async () => {
		const scrollElement = sizedScrollArea(VIEWPORT_HEIGHT)
		// jsdom neither scrolls nor sizes the content.
		const scrollTo = vi.fn<(options: ScrollToOptions) => void>()

		Object.defineProperty(scrollElement, "scrollHeight", { configurable: true, value: 20_000 * 34 })
		Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo })

		const tree = context({ isOpen: () => false, activePath: ["dir-15000"] })

		fixture.levels = { root: resolved(MANY) }

		const { rerender } = render(createElement(DirectoryTree, { tree, scrollElement: null }))

		await frames()
		rerender(createElement(DirectoryTree, { tree, scrollElement }))
		await frames()
		expect(scrollTo.mock.calls.map(([options]) => options.top).at(-1)).toBe(15_000 * 34 + 32 - VIEWPORT_HEIGHT)
	})
})
