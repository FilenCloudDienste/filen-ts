// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PageRail, type PageRailProps } from "../react/shared/pageRail"
import { dropBefore, dropCell, itemRows, railKeyTarget, railRows } from "../react/shared/railWindow"

// The shared page rail as a PDF's pages rail and Organise grid: roving focus, selection keys, moving by keys and by
// dragging, the marquee, the live region and the thumbnail window.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

describe("grid rows", () => {
	it("packs items into rows of `columns` and drops between cells", () => {
		const rows = itemRows(7, 100, 3)

		expect([...rows.items]).toEqual([0, 3, 6])
		expect([...rows.counts]).toEqual([3, 3, 1])
		expect([...rows.rowOf]).toEqual([0, 0, 0, 1, 1, 1, 2])
		// Row 1, nearest the boundary after its second cell (cells 120 wide).
		expect(dropBefore(rows, 7, 150, { position: 230, cell: 120 })).toBe(5)
		expect(dropBefore(rows, 7, 250, { position: 900, cell: 120 })).toBe(7)
		expect(dropCell(rows, 5, 120)).toEqual({ along: 100, across: 240 })
		expect(dropCell(rows, 7, 120)).toEqual({ along: 200, across: 120 })
		expect(
			railRows(
				[
					{ kind: "slide", index: 0 },
					{ kind: "section", section: 0 },
					{ kind: "slide", index: 1 }
				],
				2,
				10,
				5,
				3
			).items
		).toEqual(Int32Array.from([0, -1, 1]))
	})

	it("moves by rows with up and down in a grid", () => {
		expect(railKeyTarget("ArrowDown", 1, 10, 2, true, 4)).toBe(5)
		expect(railKeyTarget("ArrowRight", 1, 10, 2, true, 4)).toBe(2)
		expect(railKeyTarget("PageDown", 1, 10, 2, true, 4)).toBe(9)
	})
})

describe("page rail", () => {
	let host: HTMLDivElement
	let root: Root

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
		root = createRoot(host)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400)
	})

	afterEach(() => {
		act(() => root.unmount())
		host.remove()
		vi.restoreAllMocks()
	})

	function renderRail(props: Partial<PageRailProps> = {}) {
		const handlers = {
			onSelect: vi.fn(),
			onExtend: vi.fn(),
			onMove: vi.fn(),
			onToggle: vi.fn(),
			onSelectAll: vi.fn(),
			onShift: vi.fn(),
			onDelete: vi.fn(),
			onMarquee: vi.fn(),
			onWindow: vi.fn()
		}

		act(() =>
			root.render(
				<PageRail
					count={40}
					itemKey={index => `p${String(index)}`}
					aspect={1.25}
					current={0}
					label="Pages"
					itemLabel={(index, count) => `Page ${String(index + 1)} of ${String(count)}`}
					renderItem={index => <span className="number">{index + 1}</span>}
					thumbWidth={96}
					overscan={4}
					focusMode="roving"
					selected={new Set<number>()}
					{...handlers}
					{...props}
				/>
			)
		)

		return handlers
	}

	const listbox = (): HTMLElement => {
		const found = host.querySelector<HTMLElement>("[role=listbox]")

		if (found === null) throw new Error("no rail")

		return found
	}

	const key = (init: KeyboardEventInit): void => {
		act(() => listbox().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })))
	}

	it("roves the tab stop onto the current page and follows it with the focus", () => {
		renderRail({ current: 2 })

		expect(listbox().getAttribute("aria-activedescendant")).toBeNull()
		expect(host.querySelector("[data-fo-index='2']")?.getAttribute("tabindex")).toBe("0")
		expect(host.querySelector("[data-fo-index='1']")?.getAttribute("tabindex")).toBe("-1")

		act(() => host.querySelector<HTMLElement>("[data-fo-index='2']")?.focus())
		renderRail({ current: 3 })
		expect(document.activeElement?.getAttribute("data-fo-index")).toBe("3")
	})

	it("toggles with Space, extends with Shift and the arrows, selects all, deletes", () => {
		const handlers = renderRail({ current: 4 })

		key({ key: " " })
		expect(handlers.onToggle).toHaveBeenLastCalledWith(4)
		key({ key: "ArrowDown", shiftKey: true })
		expect(handlers.onExtend).toHaveBeenLastCalledWith(5, "range")
		key({ key: "a", ctrlKey: true })
		expect(handlers.onSelectAll).toHaveBeenCalledTimes(1)
		key({ key: "Delete" })
		expect(handlers.onDelete).toHaveBeenCalledTimes(1)
		key({ key: "ArrowDown" })
		expect(handlers.onSelect).toHaveBeenLastCalledWith(5)
	})

	it("moves the selection with Alt and the arrows: along a rail, and by rows in a grid", () => {
		const handlers = renderRail()

		key({ key: "ArrowDown", altKey: true })
		expect(handlers.onShift).toHaveBeenLastCalledWith(1)
		key({ key: "ArrowLeft", altKey: true })
		expect(handlers.onShift).toHaveBeenCalledTimes(1)

		// 400 px over cells of 96 + 12 + 12: 3 columns.
		const grid = renderRail({ layout: "grid", cellChrome: 12 })

		key({ key: "ArrowUp", altKey: true })
		expect(grid.onShift).toHaveBeenLastCalledWith(-3)
		key({ key: "ArrowRight", altKey: true })
		expect(grid.onShift).toHaveBeenLastCalledWith(1)
	})

	it("lays a grid out in columns and drags across it", () => {
		const handlers = renderRail({ layout: "grid", cellChrome: 12 })
		const first = host.querySelector<HTMLElement>("[data-fo-index='0']")

		if (first === null) throw new Error("no page")

		expect(host.querySelector<HTMLElement>("[data-fo-index='4']")?.style.left).toBe("120px")
		listbox().setPointerCapture = () => undefined
		vi.spyOn(listbox(), "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 400, height: 600 } as DOMRect)

		const pointer = (type: string, target: HTMLElement, x: number, y: number): void => {
			act(() =>
				target.dispatchEvent(
					new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y })
				)
			)
		}

		// Rows of 120 + 12 = 132 px; (250, 140) is row 1, nearest the boundary after its second cell.
		pointer("pointerdown", first, 20, 20)
		pointer("pointermove", listbox(), 60, 60)
		pointer("pointermove", listbox(), 250, 140)
		expect(host.querySelector(".fo-page-rail-drop")?.getAttribute("data-fo-axis")).toBe("across")
		pointer("pointerup", listbox(), 250, 140)
		expect(handlers.onMove).toHaveBeenCalledWith(5)
	})

	it("selects with a marquee from the background", () => {
		const handlers = renderRail({ layout: "grid", cellChrome: 12 })
		const content = host.querySelector<HTMLElement>(".fo-page-rail-content")

		if (content === null) throw new Error("no content")

		listbox().setPointerCapture = () => undefined
		vi.spyOn(listbox(), "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 400, height: 600 } as DOMRect)

		const pointer = (type: string, target: HTMLElement, x: number, y: number): void => {
			act(() =>
				target.dispatchEvent(
					new PointerEvent(type, {
						bubbles: true,
						button: 0,
						pointerId: 2,
						pointerType: "mouse",
						clientX: x,
						clientY: y,
						ctrlKey: true
					})
				)
			)
		}

		pointer("pointerdown", content, 390, 5)
		pointer("pointermove", listbox(), 130, 140)
		expect(host.querySelector(".fo-page-rail-marquee")).not.toBeNull()
		pointer("pointerup", listbox(), 130, 140)
		// Columns 1 and 2 of rows 0 and 1.
		expect(handlers.onMarquee).toHaveBeenCalledWith([1, 2, 4, 5], true)
	})

	it("reads the host's announcement in a polite live region", () => {
		renderRail({ announcement: "Page 3 moved to position 2" })

		const live = host.querySelector("[aria-live=polite]")

		expect(live?.textContent).toBe("Page 3 moved to position 2")
		expect(live?.getAttribute("role")).toBe("status")
	})

	it("asks thumbnails for the mounted pages only, those in view first", async () => {
		const handlers = renderRail({ current: 20 })

		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
		})

		const asked = handlers.onWindow.mock.calls.at(-1)?.[0] as number[]
		const mounted = host.querySelectorAll("[role=option]").length

		// 600 px over rows of 120 + 12: 5 in view, 4 overscan each side at most.
		expect(asked.length).toBeLessThanOrEqual(5 + 8)
		expect(asked.length).toBeGreaterThan(0)
		// Scrolled to page 21, which is asked for with the pages around it.
		expect(asked).toContain(20)
		expect(mounted).toBeLessThanOrEqual(asked.length + 1)
	})
})
