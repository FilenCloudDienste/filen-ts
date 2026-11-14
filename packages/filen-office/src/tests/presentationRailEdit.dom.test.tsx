// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { slideRef, type Section, type SlideRef } from "../core/presentation/model"
import { SlideRail, type SlideRailProps } from "../react/presentation/rail/SlideRail"
import { dropBefore, dropLineOffset, railRows, revealRowOffset, rowRange } from "../react/shared/railWindow"
import type { PresentationThumb } from "../react/presentation/store"

// The rail's section headers, its multiple selection, the host's keys and dragging slides to another place.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

function slideList(count: number) {
	return Array.from({ length: count }, (_, index) => ({ ref: slideRef(10 + index), hidden: false }))
}

const refs = (from: number, to: number): SlideRef[] => Array.from({ length: to - from }, (_, index) => slideRef(10 + from + index))

describe("rail rows", () => {
	// Slides of 102 px, headers of 28 px: [A] 0 1 [B] 2 3 4.
	const rows = railRows(
		[
			{ kind: "section", section: 0 },
			{ kind: "slide", index: 0 },
			{ kind: "slide", index: 1 },
			{ kind: "section", section: 1 },
			{ kind: "slide", index: 2 },
			{ kind: "slide", index: 3 },
			{ kind: "slide", index: 4 }
		],
		5,
		102,
		28
	)

	it("lays rows out by their extents and finds them by offset", () => {
		expect([...rows.starts]).toEqual([0, 28, 130, 232, 260, 362, 464, 566])
		expect([...rows.rowOf]).toEqual([1, 2, 4, 5, 6])
		expect(rowRange(rows, 140, 100, 0)).toEqual({ first: 2, last: 3 })
		expect(rowRange(rows, 0, 10_000, 1)).toEqual({ first: 0, last: 6 })
		expect(revealRowOffset(rows, 6, 0, 300)).toBe(266)
		expect(revealRowOffset(rows, 1, 0, 300)).toBeUndefined()
	})

	it("drops before the slide under the pointer's half, and a header's drop line goes above it", () => {
		expect(dropBefore(rows, 5, 40)).toBe(0)
		expect(dropBefore(rows, 5, 100)).toBe(1)
		// On the second header: before its section's first slide.
		expect(dropBefore(rows, 5, 240)).toBe(2)
		expect(dropBefore(rows, 5, 10_000)).toBe(5)
		// Slide 2 starts section B: its line sits above B's header (it would join the section before).
		expect(dropLineOffset(rows, 2)).toBe(232)
		expect(dropLineOffset(rows, 0)).toBe(0)
		expect(dropLineOffset(rows, 5)).toBe(566)
	})
})

describe("slide rail editing", () => {
	let host: HTMLDivElement
	let root: Root

	beforeEach(() => {
		host = document.createElement("div")
		document.body.appendChild(host)
		root = createRoot(host)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200)
	})

	afterEach(() => {
		act(() => root.unmount())
		host.remove()
		vi.restoreAllMocks()
	})

	function renderRail(props: Partial<SlideRailProps> = {}) {
		const onSelect = vi.fn()
		const onExtend = vi.fn()
		const onMove = vi.fn()

		act(() =>
			root.render(
				<SlideRail
					slides={slideList(6)}
					thumbs={new Map<SlideRef, PresentationThumb>()}
					aspect={0.5625}
					current={0}
					onSelect={onSelect}
					requestThumbnails={() => undefined}
					label="Slides"
					slideLabel={(index, count, _hidden, section) =>
						`Slide ${String(index + 1)} of ${String(count)}${section === undefined ? "" : `, ${section}`}`
					}
					onExtend={onExtend}
					onMove={onMove}
					{...props}
				/>
			)
		)

		return { onSelect, onExtend, onMove }
	}

	it("shows each section's name before its slides and names the slide that starts it", () => {
		const sections: Section[] = [
			{ id: "a", name: "Intro", slides: refs(0, 2) },
			{ id: "b", name: "Body", slides: refs(2, 6) }
		]

		renderRail({ sections })

		expect([...host.querySelectorAll(".fo-slide-rail-section")].map(header => header.textContent)).toEqual(["Intro", "Body"])
		expect(host.querySelector("[data-fo-index='2']")?.getAttribute("aria-label")).toBe("Slide 3 of 6, Body")
		expect(host.querySelector("[data-fo-index='3']")?.getAttribute("aria-label")).toBe("Slide 4 of 6")
		// Headers are not options: the listbox counts slides only.
		expect(host.querySelectorAll("[role=option]")).toHaveLength(6)
	})

	it("extends the selection by Shift and Ctrl clicks and Shift keys, and marks every selected slide", () => {
		const { onExtend, onSelect } = renderRail({ current: 1, selected: new Set([1, 3]) })

		expect(host.querySelector("[role=listbox]")?.getAttribute("aria-multiselectable")).toBe("true")
		expect([...host.querySelectorAll("[aria-selected='true']")].map(item => item.getAttribute("data-fo-index"))).toEqual(["1", "3"])
		expect(host.querySelector("[aria-current='true']")?.getAttribute("data-fo-index")).toBe("1")

		act(() =>
			host
				.querySelector<HTMLElement>("[data-fo-index='4']")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))
		)
		expect(onExtend).toHaveBeenLastCalledWith(4, "range")
		act(() =>
			host.querySelector<HTMLElement>("[data-fo-index='5']")?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }))
		)
		expect(onExtend).toHaveBeenLastCalledWith(5, "toggle")
		act(() =>
			host
				.querySelector("[role=listbox]")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }))
		)
		expect(onExtend).toHaveBeenLastCalledWith(2, "range")
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("gives the host's keys the first say", () => {
		const onCommandKey = vi.fn((event: { key: string }) => event.key === "Delete")
		const { onSelect } = renderRail({ current: 2, onCommandKey })
		const listbox = host.querySelector("[role=listbox]")

		act(() => listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })))
		expect(onCommandKey).toHaveBeenCalledTimes(1)
		act(() => listbox?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
		expect(onSelect).toHaveBeenLastCalledWith(3)
	})

	it("drags the selection with a mouse to stand before the slide it is dropped on, and the release selects nothing", () => {
		const { onMove, onSelect } = renderRail({ current: 0 })
		const listbox = host.querySelector<HTMLElement>("[role=listbox]")
		const first = host.querySelector<HTMLElement>("[data-fo-index='0']")

		if (listbox === null || first === null) throw new Error("no rail")

		listbox.setPointerCapture = () => undefined
		vi.spyOn(listbox, "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 200, height: 600 } as DOMRect)

		const pointer = (type: string, target: HTMLElement, y: number): void => {
			act(() =>
				target.dispatchEvent(
					new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: 50, clientY: y })
				)
			)
		}

		// Thumbnails 160 × 90 + 12: 102 px per slide; y 330 is in slide 3's upper half.
		pointer("pointerdown", first, 40)
		pointer("pointermove", listbox, 60)
		pointer("pointermove", listbox, 330)
		expect(host.querySelector(".fo-slide-rail-drop")?.getAttribute("style")).toContain("top: 305px")
		pointer("pointerup", listbox, 330)
		expect(onMove).toHaveBeenCalledWith(3)
		expect(host.querySelector(".fo-slide-rail-drop")).toBeNull()
		act(() => first.click())
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("after a drag whose release clicks the list, the next click on a slide selects it", async () => {
		const { onMove, onSelect } = renderRail()
		const listbox = host.querySelector<HTMLElement>("[role=listbox]")
		const first = host.querySelector<HTMLElement>("[data-fo-index='0']")
		const second = host.querySelector<HTMLElement>("[data-fo-index='1']")

		if (listbox === null || first === null || second === null) throw new Error("no rail")

		listbox.setPointerCapture = () => undefined
		vi.spyOn(listbox, "getBoundingClientRect").mockReturnValue({ top: 0, left: 0, width: 200, height: 600 } as DOMRect)

		const pointer = (type: string, target: HTMLElement, y: number): void => {
			act(() =>
				target.dispatchEvent(
					new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: 50, clientY: y })
				)
			)
		}

		pointer("pointerdown", first, 40)
		pointer("pointermove", listbox, 60)
		pointer("pointermove", listbox, 330)
		pointer("pointerup", listbox, 330)
		// The captured release's click lands on the list, not on an item.
		act(() => listbox.click())
		expect(onMove).toHaveBeenCalledWith(3)
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})
		act(() => second.click())
		expect(onSelect).toHaveBeenCalledWith(1)
	})

	it("never starts a drag from touch, which scrolls the rail", () => {
		const { onMove } = renderRail()
		const first = host.querySelector<HTMLElement>("[data-fo-index='0']")
		const listbox = host.querySelector<HTMLElement>("[role=listbox]")

		if (listbox === null || first === null) throw new Error("no rail")

		act(() => first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "touch", clientY: 10 })))
		act(() =>
			listbox.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, pointerType: "touch", clientY: 300 }))
		)
		act(() => listbox.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "touch", clientY: 300 })))
		expect(onMove).not.toHaveBeenCalled()
	})
})
