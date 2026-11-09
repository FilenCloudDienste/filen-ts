// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { DrawingList } from "../core/drawingml/index"
import { slideRef, type ShowSettings } from "../core/presentation/model"
import { drawingData } from "../core/presentation/render/slide"
import type { SlideRender } from "../dom/presentation/protocol"
import { isContextMenuKey } from "../react/presentation/presenter/keys"
import { SlideShow } from "../react/presentation/show/player"
import type { SlidePainter } from "../react/presentation/SlideView"

// The show's shortcut menu: a right click, Shift+F10 or the Menu key on the stage asks the page for it, and the
// browser's own menu never shows over the show. A kiosk has none.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }
const slides = [0, 1].map(n => ({ ref: slideRef(500 + n), hidden: false }))
const KIOSK: ShowSettings = {
	kind: "kiosk",
	loop: false,
	showNarration: true,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

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
let root: Root

beforeEach(() => {
	host = document.createElement("div")
	document.body.appendChild(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

type ContextMenuAt = { readonly x: number; readonly y: number; readonly stage: HTMLElement }

async function mount(
	onContextMenu: Mock<(at: ContextMenuAt) => void>,
	settings?: ShowSettings
): Promise<{ stage: HTMLElement; onSlide: ReturnType<typeof vi.fn> }> {
	const onSlide = vi.fn()

	act(() =>
		root.render(
			<SlideShow
				slides={slides}
				customShows={[]}
				renders={renders}
				size={SIZE}
				painter={painter}
				{...(settings === undefined ? {} : { settings })}
				onSlide={onSlide}
				onEnd={() => undefined}
				label="Slide show"
				slideLabel={() => ""}
				autoHidePointer={false}
				onContextMenu={onContextMenu}
			/>
		)
	)
	await act(async () => {
		for (let k = 0; k < 10; k++) await Promise.resolve()
	})

	const stage = host.querySelector<HTMLElement>("[data-fo-show-stage]")

	if (stage === null) throw new Error("no stage")

	return { stage, onSlide }
}

function dispatch(stage: HTMLElement, event: Event): Event {
	act(() => {
		stage.dispatchEvent(event)
	})

	return event
}

const rightClick = (): MouseEvent => new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
const keydown = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

describe("show context menu", () => {
	it("opens the show's menu on a right click, never the browser's, and does not advance", async () => {
		const onContextMenu = vi.fn<(at: ContextMenuAt) => void>()
		const { stage, onSlide } = await mount(onContextMenu)
		const outside = vi.fn()

		document.body.addEventListener("contextmenu", outside)
		expect(dispatch(stage, rightClick()).defaultPrevented).toBe(true)
		document.body.removeEventListener("contextmenu", outside)
		expect(outside).not.toHaveBeenCalled()
		expect(onContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 40, y: 30, stage })
		expect(onSlide).toHaveBeenLastCalledWith(0)
	})

	it("opens it from Shift+F10 and the Menu key, and the browser's event for that key is not a second one", async () => {
		const onContextMenu = vi.fn<(at: ContextMenuAt) => void>()
		const { stage } = await mount(onContextMenu)

		for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
			const calls = onContextMenu.mock.calls.length

			expect(dispatch(stage, keydown(init)).defaultPrevented).toBe(true)
			expect(onContextMenu).toHaveBeenCalledTimes(calls + 1)
			expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ stage }))
			expect(dispatch(stage, rightClick()).defaultPrevented).toBe(true)
			expect(onContextMenu).toHaveBeenCalledTimes(calls + 1)
		}

		// A later right click opens it again.
		dispatch(stage, rightClick())
		expect(onContextMenu).toHaveBeenCalledTimes(3)
	})

	it("gives a kiosk no menu, and no browser menu either", async () => {
		const onContextMenu = vi.fn<(at: ContextMenuAt) => void>()
		const { stage } = await mount(onContextMenu, KIOSK)

		expect(dispatch(stage, rightClick()).defaultPrevented).toBe(true)
		dispatch(stage, keydown({ key: "ContextMenu" }))
		expect(onContextMenu).not.toHaveBeenCalled()
	})

	it("takes only Shift+F10 and the bare Menu key", () => {
		const key = (init: Partial<Parameters<typeof isContextMenuKey>[0]>): boolean =>
			isContextMenuKey({ key: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init })

		expect(key({ key: "F10", shiftKey: true })).toBe(true)
		expect(key({ key: "ContextMenu" })).toBe(true)
		expect(key({ key: "F10" })).toBe(false)
		expect(key({ key: "ContextMenu", shiftKey: true })).toBe(false)
		expect(key({ key: "F10", shiftKey: true, ctrlKey: true })).toBe(false)
	})
})
