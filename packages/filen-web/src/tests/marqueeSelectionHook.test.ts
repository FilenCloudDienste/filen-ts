// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook } from "@testing-library/react"
import { createElement, type PointerEvent as ReactPointerEvent } from "react"
import { useMarqueeSelection, type MarqueeItem } from "@/features/drive/hooks/useMarqueeSelection"
import { MarqueeRect } from "@/features/drive/components/marqueeRect"

afterEach(() => {
	cleanup()
})

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

function dragTo(x: number, y: number): void {
	act(() => {
		window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }))
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
})
