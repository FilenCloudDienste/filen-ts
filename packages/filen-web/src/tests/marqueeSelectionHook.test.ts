// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook } from "@testing-library/react"
import { createElement, type PointerEvent as ReactPointerEvent } from "react"
import { MARQUEE_SKIP_PROPS, useMarqueeSelection, type MarqueeItem } from "@/features/drive/hooks/useMarqueeSelection"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"

// Animation frames run when a test says so: the marquee applies the pointer once per frame.
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = nextFrame++

		frames.set(id, callback)

		return id
	})
	vi.stubGlobal("cancelAnimationFrame", (id: number) => {
		frames.delete(id)
	})
})

afterEach(() => {
	cleanup()
	frames.clear()
	vi.unstubAllGlobals()
})

function runFrame(): void {
	const due = [...frames.values()]

	frames.clear()

	for (const callback of due) {
		callback(performance.now())
	}
}

// jsdom lays nothing out, so the container reports the client box a real 400x400 listbox would.
function container(): HTMLDivElement {
	const el = document.createElement("div")

	Object.defineProperties(el, {
		clientWidth: { value: 400 },
		clientHeight: { value: 400 },
		scrollHeight: { value: 400 }
	})
	document.body.appendChild(el)

	return el
}

interface RowItem extends MarqueeItem {
	row: string
}

function renderMarquee(
	el: HTMLDivElement,
	{
		items = [
			{ data: { uuid: "a" }, row: "a" },
			{ data: { uuid: "b" }, row: "b" }
		],
		preset = [],
		keyOf
	}: { items?: RowItem[]; preset?: RowItem[]; keyOf?: (item: RowItem) => string } = {}
) {
	const write = vi.fn<(items: RowItem[]) => void>()
	let renders = 0
	const { result } = renderHook(() => {
		renders++

		return useMarqueeSelection({
			items,
			...(keyOf === undefined ? {} : { keyOf }),
			viewMode: "list",
			columns: 1,
			geometry: { rowHeight: 40, tileWidth: 176 },
			selection: { read: () => preset, write },
			scrollElement: el,
			setCursor: vi.fn()
		})
	})

	return { result, write, renders: () => renders }
}

// A primary-button press on blank space, as the listbox's onPointerDown receives it.
function pressAt(el: HTMLDivElement, onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void, ctrlKey = false): void {
	onPointerDown({
		pointerType: "mouse",
		button: 0,
		clientX: 10,
		clientY: 10,
		metaKey: false,
		ctrlKey,
		target: el,
		currentTarget: el
	} as unknown as ReactPointerEvent<HTMLDivElement>)
}

// A move, then the frame that applies it.
function dragTo(x: number, y: number): void {
	act(() => {
		window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }))
		runFrame()
	})
}

describe("useMarqueeSelection — a press that opens a context menu", () => {
	it("arms a drag from a plain press (the control case)", () => {
		const el = container()
		const { result, write } = renderMarquee(el)

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(write).toHaveBeenCalled()
	})

	// macOS turns a Ctrl+click into a context menu while still reporting a primary-button press; the
	// pointer then moves over the open menu and must not rubber-band the listing behind it.
	it("never starts once a context menu opened from the same press", () => {
		const el = container()
		const { result, write } = renderMarquee(el)

		act(() => {
			pressAt(el, result.current.onPointerDown, true)
			window.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))
		})
		dragTo(10, 90)

		expect(write).not.toHaveBeenCalled()
		expect(result.current.rectStore.get()).toBeNull()
	})
})

// The Shared by me root lists one item once per receiver: the same uuid on two rows.
describe("useMarqueeSelection — additive union identity", () => {
	const bob: RowItem = { data: { uuid: "shared" }, row: "shared:bob" }
	const carol: RowItem = { data: { uuid: "shared" }, row: "shared:carol" }

	it("adds another receiver's row of an already-selected item when keyed by row", () => {
		const el = container()
		const { result, write } = renderMarquee(el, { items: [bob, carol], preset: [bob], keyOf: item => item.row })

		act(() => {
			pressAt(el, result.current.onPointerDown, true)
		})
		dragTo(10, 60)

		expect(write).toHaveBeenLastCalledWith([bob, carol])
	})

	it("dedupes by uuid by default", () => {
		const el = container()
		const { result, write } = renderMarquee(el, { items: [bob, carol], preset: [bob] })

		act(() => {
			pressAt(el, result.current.onPointerDown, true)
		})
		dragTo(10, 60)

		expect(write).toHaveBeenLastCalledWith([bob])
	})
})

// The rectangle moves on every pointermove; the host (the whole listing) must not re-render for it.
describe("useMarqueeSelection — rectangle updates", () => {
	it("moves the rectangle without re-rendering the host, and clears it on release", () => {
		const el = container()
		const { result, renders } = renderMarquee(el)
		const view = render(createElement(MarqueeRect, { store: result.current.rectStore }))

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})

		const before = renders()

		dragTo(10, 50)

		const first = result.current.rectStore.get()

		dragTo(20, 90)

		expect(renders()).toBe(before)
		expect(first).not.toBeNull()
		expect(result.current.rectStore.get()).not.toBe(first)
		expect(view.getByTestId("marquee-rect").style.height).toBe("80px")

		act(() => {
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: 20, clientY: 90 }))
		})

		expect(result.current.rectStore.get()).toBeNull()
		expect(view.queryByTestId("marquee-rect")).toBeNull()
	})

	// Firefox delivers pointermove at the mouse's own rate (up to 1000 Hz); Chromium aligns it to frames.
	it("applies the moves of one frame once, and writes nothing while the same rows stay covered", () => {
		const el = container()
		const { result, write } = renderMarquee(el)

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})

		act(() => {
			for (let y = 20; y <= 60; y += 2) {
				window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: y }))
			}
		})

		expect(write).not.toHaveBeenCalled()
		expect(result.current.rectStore.get()).toBeNull()

		act(() => {
			runFrame()
		})

		expect(write).toHaveBeenCalledTimes(1)
		expect(write.mock.lastCall?.[0].map(item => item.row)).toEqual(["a", "b"])
		expect(result.current.rectStore.get()?.bottom).toBe(60)

		dragTo(12, 70)

		expect(write).toHaveBeenCalledTimes(1)
		expect(result.current.rectStore.get()?.bottom).toBe(70)

		act(() => {
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: 12, clientY: 30 }))
		})

		// The release applies its own position at once.
		expect(write).toHaveBeenCalledTimes(2)
		expect(write.mock.lastCall?.[0].map(item => item.row)).toEqual(["a"])
	})
})

// A selection the host keeps by index (the archive browser's rules): the hook hands it the covered indices
// and the press-time selection, never an item array.
type IndexSelection = readonly number[]

function renderIndexMarquee(el: HTMLDivElement, { preset = [], startsOnItems }: { preset?: IndexSelection; startsOnItems?: boolean } = {}) {
	const write = vi.fn<(next: IndexSelection) => void>()
	const cover = vi.fn((indices: readonly number[], from: IndexSelection | null): IndexSelection => [...(from ?? []), ...indices])
	const setCursor = vi.fn<(index: number) => void>()
	const { result } = renderHook(() =>
		useMarqueeSelection<IndexSelection>({
			itemCount: 5,
			viewMode: "list",
			columns: 1,
			geometry: { rowHeight: 40, tileWidth: 176 },
			selection: { read: () => preset, write, cover },
			scrollElement: el,
			setCursor,
			...(startsOnItems === undefined ? {} : { startsOnItems })
		})
	)

	return { result, write, cover, setCursor }
}

function pressOn(
	el: HTMLDivElement,
	target: HTMLElement,
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void,
	ctrlKey = false
): void {
	onPointerDown({
		pointerType: "mouse",
		button: 0,
		clientX: 10,
		clientY: 10,
		metaKey: false,
		ctrlKey,
		target,
		currentTarget: el
	} as unknown as ReactPointerEvent<HTMLDivElement>)
}

function release(x: number, y: number): void {
	act(() => {
		window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y }))
	})
}

// An option row in the list: a marked control, its name and a button.
function optionIn(el: HTMLDivElement): { name: HTMLSpanElement; button: HTMLButtonElement; check: HTMLSpanElement } {
	const option = document.createElement("div")
	const name = document.createElement("span")
	const button = document.createElement("button")
	const check = document.createElement("span")

	option.setAttribute("role", "option")

	for (const [attribute, value] of Object.entries(MARQUEE_SKIP_PROPS)) {
		check.setAttribute(attribute, value)
	}

	option.append(check, name, button)
	el.appendChild(option)

	return { name, button, check }
}

describe("useMarqueeSelection — by index", () => {
	it("covers the rows under the rectangle, replacing the selection", () => {
		const el = container()
		const { result, write, cover } = renderIndexMarquee(el, { preset: [4] })

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(cover).toHaveBeenLastCalledWith([0, 1, 2], null)
		expect(write).toHaveBeenLastCalledWith([0, 1, 2])
	})

	it("adds to the press-time selection under the toggle modifier", () => {
		const el = container()
		const { result, write, cover } = renderIndexMarquee(el, { preset: [4] })

		act(() => {
			pressAt(el, result.current.onPointerDown, true)
		})
		dragTo(10, 50)

		expect(cover).toHaveBeenLastCalledWith([0, 1], [4])
		expect(write).toHaveBeenLastCalledWith([4, 0, 1])
	})

	it("puts the press-time selection back on Escape", () => {
		const el = container()
		const { result, write } = renderIndexMarquee(el, { preset: [4] })

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})
		dragTo(10, 90)
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
		})

		expect(write).toHaveBeenLastCalledWith([4])
		expect(result.current.rectStore.get()).toBeNull()
	})

	it("moves the cursor to the row the drag ends on", () => {
		const el = container()
		const { result, setCursor } = renderIndexMarquee(el)

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})
		dragTo(10, 90)
		release(10, 90)

		expect(setCursor).toHaveBeenCalledWith(2)
	})
})

describe("useMarqueeSelection — starting on an item", () => {
	it("leaves a press on an item to click-selection by default", () => {
		const el = container()
		const { name } = optionIn(el)
		const { result, write } = renderIndexMarquee(el)

		act(() => {
			pressOn(el, name, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(write).not.toHaveBeenCalled()
	})

	it("arms from an item's plain area where the list asks for it, never from its controls", () => {
		const el = container()
		const { name, button, check } = optionIn(el)
		const { result, write } = renderIndexMarquee(el, { startsOnItems: true })

		for (const control of [button, check]) {
			act(() => {
				pressOn(el, control, result.current.onPointerDown)
			})
			dragTo(10, 90)
			release(10, 90)
		}

		expect(write).not.toHaveBeenCalled()

		act(() => {
			pressOn(el, name, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(write).toHaveBeenLastCalledWith([0, 1, 2])
	})

	// The click a release ends in lands on the row it started on (or the list), where it would select that
	// row alone, or clear the selection, right after the drag made it.
	it("swallows the click a drag's release ends in, and only that one", async () => {
		const el = container()
		const { name } = optionIn(el)
		const { result } = renderIndexMarquee(el, { startsOnItems: true })
		const onClick = vi.fn()

		name.addEventListener("click", onClick)

		act(() => {
			pressOn(el, name, result.current.onPointerDown)
		})
		dragTo(10, 90)
		release(10, 90)
		name.click()

		expect(onClick).not.toHaveBeenCalled()

		await new Promise(resolve => setTimeout(resolve, 0))
		name.click()

		expect(onClick).toHaveBeenCalledOnce()
	})

	it("takes a press on an item's icon for one on the item", () => {
		const el = container()
		const { name } = optionIn(el)
		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")

		name.appendChild(icon)

		const { result, write } = renderIndexMarquee(el)

		act(() => {
			pressOn(el, icon as unknown as HTMLElement, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(write).not.toHaveBeenCalled()
	})

	// A menu portalled out of the list (a row's context menu) still bubbles its presses to the list
	// through the React tree.
	it("never arms from a press outside the list's own DOM", () => {
		const el = container()
		const portalled = document.createElement("div")

		document.body.appendChild(portalled)

		const { result, write } = renderIndexMarquee(el)

		act(() => {
			pressOn(el, portalled, result.current.onPointerDown)
		})
		dragTo(10, 90)

		expect(write).not.toHaveBeenCalled()
	})

	it("keeps the click after a drag where items never arm it", () => {
		const el = container()
		const { result } = renderIndexMarquee(el)
		const onClick = vi.fn()

		el.addEventListener("click", onClick)

		act(() => {
			pressAt(el, result.current.onPointerDown)
		})
		dragTo(10, 90)
		release(10, 90)
		el.click()

		expect(onClick).toHaveBeenCalledOnce()
	})
})
