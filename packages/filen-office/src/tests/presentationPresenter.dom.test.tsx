// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { slideRef } from "../core/presentation/model"
import { InkLayer } from "../react/presentation/ink/InkLayer"
import { createInkStore } from "../react/presentation/ink/store"
import { audienceScreenOf, createScreenPlacement } from "../react/presentation/presenter/placement"
import { createPresenterPortal } from "../react/presentation/presenter/portal"
import { budget, cpuMs } from "./timing"

// The presenter's window (a same-origin popup with the page's styles, theme and faces, or "blocked"), its screen
// placement, and ink drawn in one window appearing in the other from the same pointer event.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

// A 2D context that records the calls the layers make.
function recordingContext(log: string[]) {
	return {
		setTransform: () => undefined,
		clearRect: () => log.push("clear"),
		beginPath: () => undefined,
		moveTo: () => undefined,
		lineTo: () => log.push("lineTo"),
		stroke: () => log.push("stroke"),
		lineCap: "",
		lineJoin: "",
		lineWidth: 0,
		strokeStyle: ""
	}
}

describe("ink layers", () => {
	let host: HTMLDivElement
	let root: Root
	const logs = new Map<HTMLCanvasElement, string[]>()

	beforeEach(() => {
		host = document.createElement("div")
		document.body.append(host)
		root = createRoot(host)
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
			let log = logs.get(this)

			if (log === undefined) {
				log = []
				logs.set(this, log)
			}

			return recordingContext(log) as unknown as CanvasRenderingContext2D
		})
	})

	afterEach(() => {
		act(() => root.unmount())
		host.remove()
		logs.clear()
	})

	it("mirrors a pen stroke drawn on the presenter's slide onto the audience's in the same event", () => {
		const ink = createInkStore()
		const slide = slideRef(2)
		const size = { cx: 9_144_000, cy: 5_143_500 }

		act(() =>
			root.render(
				<>
					<div data-window="audience">
						<InkLayer
							store={ink}
							slide={slide}
							size={size}
						/>
					</div>
					<div data-window="presenter">
						<InkLayer
							store={ink}
							slide={slide}
							size={size}
							label="Ink"
						/>
					</div>
				</>
			)
		)

		const [audience, presenter] = [...host.querySelectorAll<HTMLDivElement>(".fo-ink-layer")]

		expect(audience?.style.pointerEvents).toBe("none")
		act(() => ink.setTool("pen"))
		expect(presenter?.style.pointerEvents).toBe("auto")
		expect(presenter?.getAttribute("aria-label")).toBe("Ink")

		const penOf = (layer: HTMLDivElement | undefined) => logs.get(layer?.querySelectorAll("canvas")[1] as HTMLCanvasElement) ?? []
		const before = penOf(audience).filter(call => call === "stroke").length

		ink.begin(slide, 100, 100)
		ink.extend([200, 200, 300, 300])
		expect(penOf(audience).filter(call => call === "stroke").length - before).toBe(2)
		expect(penOf(presenter).filter(call => call === "stroke").length - before).toBe(2)

		// Ink on another slide is not drawn here.
		ink.begin(slideRef(9), 1, 1)
		expect(penOf(audience).filter(call => call === "stroke").length - before).toBe(2)
	})

	it("holds full-size canvases only for a slide with strokes of their kind", () => {
		const ink = createInkStore()
		const slide = slideRef(2)
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1920, 1080))

		act(() =>
			root.render(
				<InkLayer
					store={ink}
					slide={slide}
					size={{ cx: 9_144_000, cy: 5_143_500 }}
				/>
			)
		)

		const [highlight, pen] = [...host.querySelectorAll("canvas")]
		const sizeOf = (canvas: HTMLCanvasElement | undefined) => [canvas?.width, canvas?.height]

		expect(sizeOf(highlight)).toEqual([1, 1])
		expect(sizeOf(pen)).toEqual([1, 1])
		act(() => ink.setTool("pen"))
		ink.begin(slide, 100, 100)
		ink.extend([200, 200])
		expect(sizeOf(pen)).toEqual([1920, 1080])
		expect(sizeOf(highlight)).toEqual([1, 1])
		act(() => ink.clear(slide))
		expect(sizeOf(pen)).toEqual([1, 1])
		rect.mockRestore()
	})

	it("stops the click that ends a stroke so the stage does not advance, and stays out of the way without a tool", () => {
		const ink = createInkStore()
		const clicks = vi.fn()

		act(() =>
			root.render(
				<div onClick={clicks}>
					<InkLayer
						store={ink}
						slide={slideRef(1)}
						size={{ cx: 100, cy: 100 }}
					/>
				</div>
			)
		)

		const layer = host.querySelector<HTMLDivElement>(".fo-ink-layer")

		act(() => layer?.click())
		expect(clicks).toHaveBeenCalledTimes(1)
		act(() => ink.setTool("pen"))
		act(() => layer?.click())
		expect(clicks).toHaveBeenCalledTimes(1)
	})

	it("draws a pointer event's segment for two windows in under 2 ms of main-thread time", () => {
		const ink = createInkStore()
		const slide = slideRef(2)
		const size = { cx: 9_144_000, cy: 5_143_500 }

		act(() =>
			root.render(
				<>
					<InkLayer
						store={ink}
						slide={slide}
						size={size}
					/>
					<InkLayer
						store={ink}
						slide={slide}
						size={size}
					/>
				</>
			)
		)
		act(() => ink.setTool("pen"))
		ink.begin(slide, 0, 0)

		const events = 5000
		const start = cpuMs()

		for (let event = 0; event < events; event++) ink.extend([event * 100, event * 50, event * 100 + 50, event * 50 + 25])

		expect((cpuMs() - start) / events).toBeLessThan(budget(2))
	})
})

// A popup made of a second document, as window.open("") hands back.
function fakePopup() {
	const doc = document.implementation.createHTMLDocument("")
	const listeners = new Map<string, () => void>()
	const win = {
		document: doc,
		closed: false,
		focus: vi.fn(),
		close: vi.fn(() => {
			win.closed = true
			listeners.get("pagehide")?.()
		}),
		addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
		removeEventListener: (type: string) => listeners.delete(type)
	}

	return win
}

describe("presenter portal", () => {
	afterEach(() => {
		document.head.replaceChildren()
		document.documentElement.className = ""
	})

	it("opens a same-origin popup with the page's stylesheets and theme, and keeps them in step", async () => {
		const style = document.createElement("style")

		style.textContent = ".a{color:red}"
		document.head.append(style)
		document.documentElement.className = "dark"

		const popup = fakePopup()
		const open = vi.fn(() => popup)
		const onChange = vi.fn()
		const portal = createPresenterPortal({
			opener: Object.assign(Object.create(window) as Window, {
				open,
				document,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn()
			}),
			title: "Presenter view",
			features: () => "popup,width=800,height=600",
			onChange
		})
		const opened = portal.open()

		expect(opened.kind).toBe("opened")
		expect(open).toHaveBeenCalledWith("", "filen-presenter", "popup,width=800,height=600")
		expect(popup.document.title).toBe("Presenter view")
		expect(popup.document.documentElement.className).toBe("dark")
		expect(popup.document.head.querySelector("style")?.textContent).toBe(".a{color:red}")
		expect(portal.container?.ownerDocument).toBe(popup.document)
		expect(onChange).toHaveBeenCalledTimes(1)

		// The theme flips and a sheet is added later.
		document.documentElement.className = "light"

		const later = document.createElement("style")

		later.textContent = ".b{}"
		document.head.append(later)
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(popup.document.documentElement.className).toBe("light")
		expect(popup.document.head.querySelectorAll("style")).toHaveLength(2)

		// Opening again focuses the same window.
		expect(portal.open().kind).toBe("opened")
		expect(open).toHaveBeenCalledTimes(1)
		expect(popup.focus).toHaveBeenCalled()

		// The user closes it.
		popup.close()
		expect(portal.window).toBeUndefined()
		expect(portal.container).toBeUndefined()
		expect(onChange).toHaveBeenCalledTimes(2)
	})

	it("reports a blocked popup", () => {
		const portal = createPresenterPortal({
			opener: Object.assign(Object.create(window) as Window, { open: () => null, document }),
			title: "Presenter view",
			features: () => "popup"
		})

		expect(portal.open()).toEqual({ kind: "blocked" })
		expect(portal.window).toBeUndefined()
	})
})

describe("screen placement", () => {
	const laptop = { availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 900, isPrimary: true, isInternal: true }
	const projector = { availLeft: 1440, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false, isInternal: false }

	it("puts the audience on another screen, an external one first", () => {
		expect(audienceScreenOf({ screens: [laptop, projector], currentScreen: laptop })).toBe(projector)
		expect(audienceScreenOf({ screens: [laptop], currentScreen: laptop })).toBeUndefined()
	})

	it("uses the screens only when the permission is already granted", async () => {
		const getScreenDetails = vi.fn(() => Promise.resolve({ screens: [laptop, projector], currentScreen: laptop }))
		const opener = (state: string) =>
			Object.assign(Object.create(window) as Window, {
				getScreenDetails,
				navigator: { permissions: { query: () => Promise.resolve({ state }) } },
				screen: { availWidth: 1440, availHeight: 900 },
				screenX: 0,
				screenY: 0,
				outerWidth: 1440,
				outerHeight: 900
			})
		const prompt = createScreenPlacement(opener("prompt"))

		expect(await prompt.refresh()).toBe(false)
		expect(getScreenDetails).not.toHaveBeenCalled()
		expect(prompt.fullscreenOptions()).toBeUndefined()
		expect(prompt.features()).toBe("popup,left=120,top=70,width=1200,height=760")

		const granted = createScreenPlacement(opener("granted"))

		expect(await granted.refresh()).toBe(true)
		expect(granted.features()).toBe("popup,left=0,top=0,width=1440,height=900")
		expect(granted.fullscreenOptions()).toMatchObject({ screen: projector })
	})
})
