// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import {
	cancelPointerDrag,
	DRAG_SCROLL_ATTRIBUTE,
	pointerDragChip,
	pressPointerDrag,
	registerDropTarget,
	resumePointerDrag,
	setPointerDragHooks,
	type DropTargetHandlers,
	type PointerDragSource
} from "@/features/drive/lib/pointerDrag"

const ITEM = narrowItem({
	uuid: "report-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "home-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

let hit: Element | null = null
let unregister: (() => void)[] = []

function source(overrides: Partial<PointerDragSource> = {}): PointerDragSource & { end: ReturnType<typeof vi.fn> } {
	const end = vi.fn()

	return { start: () => [ITEM], chip: () => document.createElement("canvas"), end, ...overrides } as PointerDragSource & {
		end: ReturnType<typeof vi.fn>
	}
}

function target(accepts = true) {
	const element = document.createElement("div")
	const handlers = {
		accepts: vi.fn(() => accepts),
		springs: vi.fn(() => false),
		update: vi.fn(),
		drop: vi.fn()
	} satisfies DropTargetHandlers

	document.body.appendChild(element)
	unregister.push(registerDropTarget(element, handlers))

	return { element, handlers }
}

function press(pointerType = "mouse", drag: PointerDragSource = source()): void {
	pressPointerDrag(
		{ pointerId: 1, pointerType, button: 0, isPrimary: true, clientX: 10, clientY: 10, altKey: false, ctrlKey: false },
		drag
	)
}

function move(x: number, y: number, init: PointerEventInit = {}): void {
	window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: y, buttons: 1, ...init }))
}

function up(x: number, y: number): void {
	window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y, buttons: 0 }))
}

function frame(): void {
	vi.advanceTimersToNextFrame()
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] })
	document.elementFromPoint = () => hit
})

afterEach(() => {
	cancelPointerDrag()
	setPointerDragHooks(null)

	for (const off of unregister) {
		off()
	}

	unregister = []
	hit = null
	document.body.replaceChildren()
	vi.useRealTimers()
})

describe("the pointer drag engine", () => {
	it("starts only past the threshold, then drops on the target under the pointer", () => {
		const drag = source({ start: vi.fn(() => [ITEM]) })
		const { element, handlers } = target()

		hit = element
		press("mouse", drag)
		move(12, 10)
		expect(drag.start).not.toHaveBeenCalled()

		move(30, 30)
		expect(drag.start).toHaveBeenCalledOnce()
		expect(document.body.classList.contains("pointer-drag")).toBe(true)
		frame()
		expect(handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, element)

		up(30, 30)
		expect(handlers.drop).toHaveBeenCalledExactlyOnceWith("move")
		expect(handlers.update).toHaveBeenLastCalledWith(null, element)
		expect(drag.end).toHaveBeenCalledOnce()
		expect(document.body.classList.contains("pointer-drag")).toBe(false)
	})

	it("tells a target only when its state changes, hit-testing once per frame", () => {
		const { element, handlers } = target()
		const elementFromPoint = vi.fn(() => element)

		document.elementFromPoint = elementFromPoint
		press()
		move(30, 30)
		move(31, 30)
		move(32, 30)
		frame()
		move(33, 30)
		frame()

		expect(elementFromPoint).toHaveBeenCalledTimes(2)
		expect(handlers.update).toHaveBeenCalledOnce()
	})

	it("drops through a refusing inner target to the accepting one around it", () => {
		const outer = target()
		const inner = target(false)

		outer.element.appendChild(inner.element)
		hit = inner.element
		press()
		move(30, 30)
		up(30, 30)

		expect(inner.handlers.drop).not.toHaveBeenCalled()
		expect(outer.handlers.drop).toHaveBeenCalledExactlyOnceWith("move")
	})

	it("changing the copy modifier mid-drag updates the mode without moving", () => {
		const { element, handlers } = target()

		hit = element
		press()
		move(30, 30)
		frame()
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))
		frame()
		expect(handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "copy", spring: false }, element)
		expect(document.body.classList.contains("pointer-drag-copy")).toBe(true)

		window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", ctrlKey: false }))
		frame()
		expect(handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, element)
	})

	it("shows the no-drop cursor where nothing takes the drop", () => {
		press()
		move(30, 30)
		frame()

		expect(document.body.classList.contains("pointer-drag-none")).toBe(true)
	})

	it("the click after a drag does not reach the page, a plain click does", () => {
		const onClick = vi.fn()

		document.body.addEventListener("click", onClick)
		press()
		move(30, 30)
		up(30, 30)
		document.body.click()
		expect(onClick).not.toHaveBeenCalled()

		vi.runAllTimers()
		press()
		up(10, 10)
		document.body.click()
		expect(onClick).toHaveBeenCalledOnce()
		document.body.removeEventListener("click", onClick)
	})

	it("Escape aborts and does not reach other handlers", () => {
		const onKey = vi.fn()
		const onEnd = vi.fn()
		const { element, handlers } = target()

		setPointerDragHooks({ onEnd })
		document.addEventListener("keydown", onKey)
		hit = element
		press()
		move(30, 30)
		frame()

		const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })

		document.body.dispatchEvent(escape)
		expect(escape.defaultPrevented).toBe(true)
		expect(onKey).not.toHaveBeenCalled()
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(false)
		expect(handlers.update).toHaveBeenLastCalledWith(null, element)

		up(30, 30)
		expect(handlers.drop).not.toHaveBeenCalled()
		document.removeEventListener("keydown", onKey)
	})

	it.each([
		[
			"a move with no buttons",
			() => {
				move(40, 40, { buttons: 0 })
			}
		],
		["pointercancel", () => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }))],
		["the window losing focus", () => window.dispatchEvent(new Event("blur"))]
	])("%s ends the drag without a drop", (_label, end) => {
		const drag = source()
		const { element, handlers } = target()

		hit = element
		press("mouse", drag)
		move(30, 30)
		end()

		expect(drag.end).toHaveBeenCalledOnce()
		up(30, 30)
		expect(handlers.drop).not.toHaveBeenCalled()
	})

	it("a touch pointerdown starts no engine drag", () => {
		const drag = source({ start: vi.fn(() => [ITEM]) })

		press("touch", drag)
		move(60, 60)

		expect(drag.start).not.toHaveBeenCalled()
	})

	it("a context menu opened by the press is no drag", () => {
		const drag = source({ start: vi.fn(() => [ITEM]) })

		press("mouse", drag)
		window.dispatchEvent(new MouseEvent("contextmenu"))
		move(60, 60)

		expect(drag.start).not.toHaveBeenCalled()
	})

	it("a source that has nothing to drag starts nothing", () => {
		const drag = source({ start: () => undefined })

		press("mouse", drag)
		move(60, 60)

		expect(document.body.classList.contains("pointer-drag")).toBe(false)
		expect(drag.end).not.toHaveBeenCalled()
	})

	it("the listing auto-scrolls near its edge during a drag", () => {
		const scroller = document.createElement("div")
		const row = document.createElement("div")

		scroller.setAttribute(DRAG_SCROLL_ATTRIBUTE, "")
		scroller.appendChild(row)
		document.body.appendChild(scroller)
		Object.defineProperty(scroller, "scrollHeight", { value: 1000 })
		Object.defineProperty(scroller, "clientHeight", { value: 200 })
		scroller.getBoundingClientRect = () => ({ top: 0, height: 200, left: 0, width: 300, right: 300, bottom: 200 }) as DOMRect
		hit = row
		press()
		move(30, 100)
		frame()
		expect(scroller.scrollTop).toBe(0)

		move(30, 195)
		frame()
		const first = scroller.scrollTop

		expect(first).toBeGreaterThan(0)
		frame()
		expect(scroller.scrollTop).toBeGreaterThan(first)
	})

	it("hands the drag off when the hooks say so, and resumes it", () => {
		const onMove = vi.fn<(p: { x: number; y: number }, outside: boolean, buttons: number) => "continue" | "handedOff">(() => "continue")
		const onStart = vi.fn()
		const { element, handlers } = target()

		setPointerDragHooks({ onStart, onMove })
		hit = element
		press()
		move(30, 30)
		expect(onStart).toHaveBeenCalledExactlyOnceWith([ITEM])
		expect(onMove).toHaveBeenLastCalledWith({ x: 30, y: 30 }, false, 1)
		frame()

		onMove.mockReturnValue("handedOff")
		move(-5, 30)
		expect(onMove).toHaveBeenLastCalledWith({ x: -5, y: 30 }, true, 1)
		expect(handlers.update).toHaveBeenLastCalledWith(null, element)
		expect(pointerDragChip()?.style.display).toBe("none")

		resumePointerDrag()
		expect(pointerDragChip()?.style.display).toBe("")
		frame()
		expect(handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, element)
	})

	it("re-hit-tests when a target appears under a resting pointer", () => {
		press()
		move(30, 30)
		frame()

		const { element, handlers } = target()

		hit = element
		frame()
		expect(handlers.update).toHaveBeenCalledExactlyOnceWith({ over: true, mode: "move", spring: false }, element)
	})

	it("springs the nearest target that can, even one that refuses the drop", () => {
		const outer = target()
		const inner = target(false)

		inner.handlers.springs.mockReturnValue(true)
		outer.element.appendChild(inner.element)
		hit = inner.element
		press()
		move(30, 30)
		frame()

		expect(inner.handlers.update).toHaveBeenLastCalledWith({ over: false, mode: "move", spring: true }, inner.element)
		expect(outer.handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, outer.element)
	})

	// A cancelled HTML5 drag produced no click on release; the row under the pointer must not select.
	it.each([
		["Escape", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))],
		["the window losing focus", () => window.dispatchEvent(new Event("blur"))]
	])("a drag %s cancelled before the release swallows the release's click", (_label, cancel) => {
		const row = document.createElement("div")
		const select = vi.fn()

		row.addEventListener("click", select)
		document.body.appendChild(row)
		press()
		move(30, 30)
		cancel()
		vi.advanceTimersByTime(1000)
		row.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, clientX: 30, clientY: 30 }))
		row.click()
		expect(select).not.toHaveBeenCalled()

		// Only that one click: the next press clicks as ever.
		vi.runAllTimers()
		row.click()
		expect(select).toHaveBeenCalledOnce()
	})

	it("swallows no later click when the next press comes without a release seen", () => {
		const row = document.createElement("div")
		const select = vi.fn()

		row.addEventListener("click", select)
		document.body.appendChild(row)
		press()
		move(30, 30)
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
		row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }))
		row.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }))
		row.click()

		expect(select).toHaveBeenCalledOnce()
	})

	it("scrolling the listing under a stationary pointer updates the target", () => {
		const scroller = document.createElement("div")
		const first = target()
		const second = target()

		scroller.append(first.element, second.element)
		document.body.appendChild(scroller)
		hit = first.element
		press()
		move(30, 30)
		frame()
		expect(first.handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, first.element)

		hit = second.element
		scroller.dispatchEvent(new Event("scroll"))
		frame()
		expect(first.handlers.update).toHaveBeenLastCalledWith(null, first.element)
		expect(second.handlers.update).toHaveBeenLastCalledWith({ over: true, mode: "move", spring: false }, second.element)
	})
})
