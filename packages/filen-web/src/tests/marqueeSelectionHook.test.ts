// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useMarqueeSelection, type MarqueeItem } from "@/features/drive/hooks/useMarqueeSelection"

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

function renderMarquee(el: HTMLDivElement) {
	const write = vi.fn()
	const items: MarqueeItem[] = [{ data: { uuid: "a" } }, { data: { uuid: "b" } }]
	const { result } = renderHook(() =>
		useMarqueeSelection({
			items,
			viewMode: "list",
			columns: 1,
			geometry: { rowHeight: 40, tileWidth: 176, gap: 0 },
			selection: { read: () => [], write },
			scrollElement: el,
			setCursor: vi.fn()
		})
	)

	return { result, write }
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
		expect(result.current.rect).toBeNull()
	})
})
