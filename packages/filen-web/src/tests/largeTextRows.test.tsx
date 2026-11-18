// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { PagerRowView, PagerRows } from "@/features/preview/workers/textPager.worker"
import type { TextPagerReading } from "@/features/preview/hooks/useTextPagerSession"
import { LargeTextRows, type PagerJump } from "@/features/preview/components/largeTextRows"
import { positionStore } from "@/features/preview/lib/textPager/viewport.logic"
import { searchPattern } from "@/features/preview/lib/textPager/search.logic"

// The large text viewer's rows: a match made active is scrolled into view sideways once, by this scroller only; the
// user's own scrolling afterwards is never pulled back to it.

const SIZE = 10_000_000

function row(start: number, text: string): PagerRowView {
	return { start, end: start + text.length + 1, text, continuation: false, breaks: true, line: null }
}

const ROWS = Array.from({ length: 60 }, (_, index) => row(index * 200, `${"x".repeat(150)} needle ${String(index)}`))

function reading(rows: readonly PagerRowView[] = ROWS, column = 151): TextPagerReading {
	const remote = {
		locate: (): Promise<PagerRows> => Promise.resolve({ rows, focus: 5, column }),
		after: () => Promise.resolve([]),
		lineOf: () => Promise.resolve({ line: 1, frontier: SIZE }),
		before: () => Promise.resolve([])
	}

	return {
		pager: { run: (call: (api: typeof remote) => unknown) => call(remote) } as unknown as TextPagerReading["pager"],
		size: SIZE,
		start: 0,
		detected: "utf-8",
		label: "utf-8",
		reopen: () => undefined,
		fail: () => undefined
	}
}

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("LargeTextRows", () => {
	it("scrolls a new active match into view sideways once, and leaves later scrolling alone", async () => {
		const intoView = vi.fn()

		Element.prototype.scrollIntoView = intoView
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			const left = this.hasAttribute("data-active-match") ? 1200 : 0

			return {
				left,
				right: left + 60,
				top: 0,
				bottom: 20,
				width: this.hasAttribute("data-active-match") ? 60 : 0,
				height: 20,
				x: left,
				y: 0,
				toJSON: () => ({})
			}
		})

		const jump: PagerJump = { seq: 1, offset: 5 * 200 + 151, before: 3, line: null, match: true }

		render(
			<LargeTextRows
				reading={reading()}
				alt="big.log"
				fontSize={13}
				pattern={searchPattern("needle", false)}
				jump={jump}
				linesVersion={0}
				position={positionStore()}
			/>
		)

		const scroller = screen.getByRole("document", { name: "big.log" })

		await act(async () => {
			await Promise.resolve()
		})
		expect(scroller.querySelector("[data-active-match]")?.textContent).toBe("needle")
		expect(scroller.scrollLeft).toBeGreaterThan(0)

		scroller.scrollLeft = 0
		fireEvent.wheel(scroller, { deltaY: 40 })
		fireEvent.keyDown(scroller, { key: "ArrowDown" })
		await act(async () => {
			await Promise.resolve()
		})

		expect(scroller.scrollLeft).toBe(0)
		expect(scroller.scrollTop).toBe(0)
		expect(intoView).not.toHaveBeenCalled()
	})

	it("marks at most 200 matches a row and 2000 a screen, the active one always", async () => {
		const long = Array.from({ length: 60 }, (_, index) => row(index * 5000, "a".repeat(4096)))

		render(
			<LargeTextRows
				reading={reading(long, 4000)}
				alt="big.log"
				fontSize={13}
				pattern={searchPattern("a", true)}
				jump={{ seq: 1, offset: 5 * 5000 + 4000, before: 3, line: null, match: true }}
				linesVersion={0}
				position={positionStore()}
			/>
		)

		const scroller = screen.getByRole("document", { name: "big.log" })

		await act(async () => {
			await Promise.resolve()
		})

		const rows = [...scroller.querySelectorAll("[data-row]")]

		expect(rows.length).toBeGreaterThan(10)
		expect(rows.every(each => each.querySelectorAll("mark").length <= 201)).toBe(true)
		expect(scroller.querySelectorAll("mark").length).toBeLessThanOrEqual(2001)
		expect(scroller.querySelector("[data-active-match]")).not.toBeNull()
	})

	it("leaves Ctrl with the wheel to the browser's zoom, and scrolls sideways with Shift", async () => {
		const position = positionStore()

		render(
			<LargeTextRows
				reading={reading()}
				alt="big.log"
				fontSize={13}
				pattern={null}
				jump={null}
				linesVersion={0}
				position={position}
			/>
		)

		const scroller = screen.getByRole("document", { name: "big.log" })

		await act(async () => {
			await Promise.resolve()
		})

		const before = position.get()
		const zoom = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true, bubbles: true })

		scroller.dispatchEvent(zoom)
		expect(zoom.defaultPrevented).toBe(false)

		const sideways = new WheelEvent("wheel", { deltaY: 100, shiftKey: true, cancelable: true, bubbles: true })

		scroller.dispatchEvent(sideways)
		await act(async () => {
			await Promise.resolve()
		})
		expect(sideways.defaultPrevented).toBe(true)
		expect(scroller.scrollLeft).toBe(100)
		// Neither moved the rows.
		expect(position.get()).toBe(before)
	})

	it("has a scrollbar that names the rows it controls and takes the keys", async () => {
		const position = positionStore()

		render(
			<LargeTextRows
				reading={reading()}
				alt="big.log"
				fontSize={13}
				pattern={null}
				jump={null}
				linesVersion={0}
				position={position}
			/>
		)

		const scroller = screen.getByRole("document", { name: "big.log" })
		const scrollbar = screen.getByRole("scrollbar", { name: "Position in file" })

		await act(async () => {
			await Promise.resolve()
		})
		expect(scrollbar.getAttribute("aria-controls")).toBe(scroller.id)
		expect(scrollbar.tabIndex).toBe(0)

		const before = position.get()

		fireEvent.keyDown(scrollbar, { key: "PageDown" })
		await act(async () => {
			await Promise.resolve()
		})
		expect(position.get()).toBeGreaterThan(before)
	})

	it("carries a released touch drag on, slowing to a stop", async () => {
		const position = positionStore()

		render(
			<LargeTextRows
				reading={reading()}
				alt="big.log"
				fontSize={13}
				pattern={null}
				jump={null}
				linesVersion={0}
				position={position}
			/>
		)

		const scroller = screen.getByRole("document", { name: "big.log" })

		await act(async () => {
			await Promise.resolve()
		})

		const touch = { pointerType: "touch", pointerId: 1 }

		fireEvent.pointerDown(scroller, { ...touch, clientY: 400 })
		await new Promise(resolve => setTimeout(resolve, 20))
		fireEvent.pointerMove(scroller, { ...touch, clientY: 360 })
		fireEvent.pointerUp(scroller, { ...touch, clientY: 360 })

		const released = position.get()

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 150))
		})
		expect(position.get()).toBeGreaterThan(released)
	})

	it("numbers the rows it holds once lines are counted, without moving them", async () => {
		const props = {
			reading: reading(),
			alt: "big.log",
			fontSize: 13,
			pattern: null,
			jump: null,
			position: positionStore()
		}
		const view = render(
			<LargeTextRows
				{...props}
				linesVersion={0}
			/>
		)
		const scroller = screen.getByRole("document", { name: "big.log" })

		await act(async () => {
			await Promise.resolve()
		})

		const before = [...scroller.querySelectorAll("[data-row]")].map(each => each.textContent)

		view.rerender(
			<LargeTextRows
				{...props}
				linesVersion={1}
			/>
		)
		await act(async () => {
			await Promise.resolve()
		})

		const after = [...scroller.querySelectorAll("[data-row]")].map(each => each.textContent)

		// The same rows, now each led by its line number (row 5 of the held rows is the first shown: line 6).
		expect(after).toHaveLength(before.length)
		expect(after[0]).toBe(`6${before[0] ?? ""}`)
	})
})
