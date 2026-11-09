// @vitest-environment happy-dom
import { act } from "react"
import { createPortal } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DrawingList } from "../core/drawingml/index"
import { slideRef, type ShowSettings } from "../core/presentation/model"
import { drawingData } from "../core/presentation/render/slide"
import type { SlideRender } from "../dom/presentation/protocol"
import { SlideShow, type ShowBarState } from "../react/presentation/show/player"
import { showOptionsOf } from "../react/presentation/show/timeline"
import { WHEEL_QUIET_MS, WheelSteps } from "../react/presentation/show/wheel"
import type { SlidePainter } from "../react/presentation/SlideView"

// Browsed by an individual: the show in a window over the page's status bar, stepped by the mouse wheel; the bar's
// clicks, pointers, menus and portaled keys are not the slide's. A show without a bar keeps its wheel off.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }
const slides = [0, 1, 2].map(n => ({ ref: slideRef(600 + n), hidden: false }))

function drawing(): ReturnType<typeof drawingData> {
	const list = new DrawingList()

	list.width = 1280
	list.height = 720

	return drawingData(list)
}

const renders = new Map(
	slides.map((slide, index): [typeof slide.ref, SlideRender] => [
		slide.ref,
		{ ref: slide.ref, index, revision: 0, hidden: false, background: drawing(), layers: [], notesText: "", animated: false }
	])
)

const painter: SlidePainter = (_render, context) => ({ root: context.document.createElement("div"), release: () => undefined })

let host: HTMLDivElement
let outside: HTMLDivElement
let root: Root

beforeEach(() => {
	host = document.createElement("div")
	outside = document.createElement("div")
	document.body.append(host, outside)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
	outside.remove()
})

async function flush(): Promise<void> {
	await act(async () => {
		for (let k = 0; k < 10; k++) await Promise.resolve()
	})
}

interface Mounted {
	readonly stage: HTMLElement
	readonly onSlide: ReturnType<typeof vi.fn>
	readonly onEnd: ReturnType<typeof vi.fn>
	readonly onContextMenu: ReturnType<typeof vi.fn>
	readonly bar: ShowBarState[]
}

async function mount(browse: boolean): Promise<Mounted> {
	const onSlide = vi.fn()
	const onEnd = vi.fn()
	const onContextMenu = vi.fn()
	const bar: ShowBarState[] = []

	act(() =>
		root.render(
			<SlideShow
				slides={slides}
				customShows={[]}
				renders={renders}
				size={SIZE}
				painter={painter}
				onSlide={onSlide}
				onEnd={onEnd}
				label="Slide show"
				slideLabel={() => ""}
				onContextMenu={onContextMenu}
				{...(browse
					? {
							statusBar: (state: ShowBarState) => {
								bar.push(state)

								return (
									<>
										<button type="button">Next</button>
										{createPortal(<button type="button">Menu item</button>, outside)}
									</>
								)
							}
						}
					: {})}
			/>
		)
	)
	await flush()

	const stage = host.querySelector<HTMLElement>("[data-fo-show-stage]")

	if (stage === null) throw new Error("no stage")

	return { stage, onSlide, onEnd, onContextMenu, bar }
}

let clock = 1000

function wheel(target: EventTarget, deltaY: number, gap = WHEEL_QUIET_MS + 50, ctrlKey = false): WheelEvent {
	clock += gap

	const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY })

	// happy-dom's WheelEvent takes no modifier keys.
	Object.defineProperty(event, "ctrlKey", { value: ctrlKey })
	Object.defineProperty(event, "timeStamp", { value: clock })
	act(() => {
		target.dispatchEvent(event)
	})

	return event
}

const keydown = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, code: key })

describe("wheel steps", () => {
	const at = (timeStamp: number, deltaY: number, deltaX = 0, deltaMode = 0) => ({ timeStamp, deltaY, deltaX, deltaMode })

	it("steps once per gesture, a trackpad's momentum tail included", () => {
		const steps = new WheelSteps()

		expect(steps.take(at(0, 100))).toBe(1)
		expect([16, 32, 48, 64].map(t => steps.take(at(t, 30)))).toEqual([0, 0, 0, 0])
		expect(steps.take(at(64 + WHEEL_QUIET_MS + 1, 100))).toBe(1)
	})

	it("steps back on the wheel up, and the other way within a gesture once", () => {
		const steps = new WheelSteps()

		expect(steps.take(at(0, -100))).toBe(-1)
		expect(steps.take(at(20, 100))).toBe(1)
		expect(steps.take(at(40, 100))).toBe(0)
	})

	it("needs a few px of travel, reads lines and pages, and ignores horizontal scrolls", () => {
		const steps = new WheelSteps()

		expect(steps.take(at(0, 1))).toBe(0)
		expect(steps.take(at(10, 3))).toBe(1)
		expect(new WheelSteps().take(at(0, 0.2, 0, 1))).toBe(1)
		expect(new WheelSteps().take(at(0, 40, 120))).toBe(0)
	})
})

describe("browsed show", () => {
	it("reads p:browse from the deck's settings", () => {
		const show: ShowSettings = {
			kind: "browse",
			loop: false,
			showNarration: true,
			showAnimation: true,
			useTimings: true,
			range: { kind: "all" }
		}

		expect(showOptionsOf(show).browse).toBe(true)
		expect(showOptionsOf({ ...show, kind: "present" }).browse).toBeUndefined()
	})

	it("lays the slide over the status bar and tells the bar the slide on stage", async () => {
		const { stage, bar } = await mount(true)

		expect(stage.hasAttribute("data-fo-browse")).toBe(true)
		expect(stage.querySelector(".fo-show-area .fo-show-viewport")).not.toBeNull()
		expect(stage.querySelector("[data-fo-show-bar] button")?.textContent).toBe("Next")
		expect(bar.at(-1)).toEqual({ index: 0, screen: "slide" })
	})

	it("steps by the wheel, one slide per turn, and takes the wheel from the page", async () => {
		const { stage, onSlide, bar } = await mount(true)

		expect(wheel(stage, 100).defaultPrevented).toBe(true)
		await flush()
		expect(onSlide).toHaveBeenLastCalledWith(1)
		wheel(stage, 40, 16)
		await flush()
		expect(onSlide).toHaveBeenLastCalledWith(1)
		wheel(stage, 100)
		await flush()
		expect(onSlide).toHaveBeenLastCalledWith(2)
		expect(bar.at(-1)?.index).toBe(2)
		wheel(stage, -100)
		await flush()
		expect(onSlide).toHaveBeenLastCalledWith(1)
		// Ctrl+wheel is the browser's zoom.
		expect(wheel(stage, 100, undefined, true).defaultPrevented).toBe(false)
	})

	it("keeps the bar's clicks, right clicks and its menus' keys off the slide; arrows and Esc stay the show's", async () => {
		const { stage, onSlide, onEnd, onContextMenu } = await mount(true)
		const button = stage.querySelector<HTMLElement>("[data-fo-show-bar] button")
		const portaled = outside.querySelector<HTMLElement>("button")

		if (button === null || portaled === null) throw new Error("no bar")

		act(() => {
			button.click()
		})
		await flush()
		expect(onSlide).not.toHaveBeenCalledWith(1)
		act(() => {
			button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))
		})
		expect(onContextMenu).not.toHaveBeenCalled()
		act(() => {
			portaled.dispatchEvent(keydown("ArrowRight"))
		})
		await flush()
		expect(onSlide).not.toHaveBeenCalledWith(1)
		act(() => {
			button.dispatchEvent(keydown("ArrowRight"))
		})
		await flush()
		expect(onSlide).toHaveBeenLastCalledWith(1)
		act(() => {
			stage.dispatchEvent(keydown("Escape"))
		})
		await flush()
		expect(onEnd).toHaveBeenCalled()
	})

	it("leaves the wheel alone in a show without a status bar", async () => {
		const { stage, onSlide } = await mount(false)

		expect(stage.hasAttribute("data-fo-browse")).toBe(false)
		expect(stage.querySelector(".fo-show-area")).toBeNull()
		expect(wheel(stage, 100).defaultPrevented).toBe(false)
		await flush()
		expect(onSlide).not.toHaveBeenCalledWith(1)
	})
})
