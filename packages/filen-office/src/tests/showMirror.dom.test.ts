// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ShowController, ShowMirror } from "../react/presentation/show/controller"
import { ShowMirrorLink, StageMirror } from "../react/presentation/show/mirror"

// The presenter's copy of the stage: structure and attributes from the stage's mutations, layer bitmaps copied once at
// the copy's resolution, transition pieces and tints on every frame, video at each presented frame, click targets left
// out, gone nodes freed; and the link that keeps one copy on the controller driving the show.

interface Drawn {
	readonly canvas: HTMLCanvasElement
	readonly args: readonly unknown[]
}

let drawn: Drawn[]

beforeEach(() => {
	drawn = []
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		return {
			canvas: this,
			clearRect: () => undefined,
			drawImage(this: { canvas: HTMLCanvasElement }, ...args: unknown[]) {
				drawn.push({ canvas: this.canvas, args })
			}
		} as unknown as CanvasRenderingContext2D
	} as unknown as HTMLCanvasElement["getContext"])
})

afterEach(() => {
	document.body.replaceChildren()
})

function canvas(className: string, width: number, height: number, cssWidth: number): HTMLCanvasElement {
	const element = document.createElement("canvas")

	element.className = className
	element.width = width
	element.height = height
	element.style.cssText = `position:absolute;left:0;top:0;width:${String(cssWidth)}px;height:${String((cssWidth * height) / width)}px`

	return element
}

// A stage host with one slide box: a layer element holding a bitmap at 2 device px per slide px, and a hotspot.
function stage(): { host: HTMLElement; slide: HTMLElement; layer: HTMLElement; bitmap: HTMLCanvasElement } {
	const host = document.createElement("div")
	const slide = document.createElement("div")
	const layer = document.createElement("div")
	const bitmap = canvas("fo-show-bitmap", 400, 200, 200)
	const hotspot = document.createElement("button")

	slide.className = "fo-show-slide-box"
	slide.dataset["foShowSlide"] = ""
	layer.className = "fo-show-layer"
	layer.dataset["foShowLayer"] = "0"
	hotspot.className = "fo-slide-hotspot"
	layer.append(bitmap, hotspot)
	slide.append(layer)
	host.append(slide)
	document.body.append(host)

	return { host, slide, layer, bitmap }
}

function mirrorOf(host: HTMLElement, ratio = 1): { mirror: StageMirror; target: HTMLElement } {
	const target = document.createElement("div")

	document.body.append(target)

	return { mirror: new StageMirror(host, target, ratio, () => 2), target }
}

describe("StageMirror", () => {
	it("copies the stage's tree without its click targets, bitmaps at the copy's resolution", () => {
		const { host, bitmap } = stage()
		const { target } = mirrorOf(host, 1)
		const copy = target.querySelector<HTMLCanvasElement>("canvas")

		expect(target.querySelector(".fo-show-slide-box [data-fo-show-layer='0']")).not.toBeNull()
		expect(target.querySelector("button")).toBeNull()
		// 400 device px over 200 slide px, copied at 1 device px per slide px.
		expect([copy?.width, copy?.height]).toEqual([200, 100])
		expect(copy?.style.width).toBe("200px")
		expect(drawn.filter(entry => entry.canvas === copy).map(entry => entry.args[0])).toEqual([bitmap])
	})

	it("never copies above the stage's resolution", () => {
		const { host } = stage()
		const { target } = mirrorOf(host, 6)

		expect(target.querySelector<HTMLCanvasElement>("canvas")?.width).toBe(400)
	})

	it("takes the frame's attributes in the frame, and the stage's own box only for whether the slide shows", () => {
		const { host, layer } = stage()
		const { mirror, target } = mirrorOf(host)

		layer.style.transform = "matrix(1, 0, 0, 1, 10, 0)"
		layer.style.opacity = "0.5"
		host.style.transform = "scale(3)"
		host.style.visibility = "hidden"
		mirror.frame()

		const copy = target.querySelector<HTMLElement>("[data-fo-show-layer='0']")

		expect(copy?.style.transform).toBe(layer.style.transform)
		expect(copy?.style.opacity).toBe("0.5")
		expect(target.style.transform).toBe("")
		expect(target.style.visibility).toBe("hidden")
	})

	it("draws a slide's bitmaps once, and a transition's pieces and tints on every frame", () => {
		const { host, layer } = stage()
		const { mirror, target } = mirrorOf(host)
		const tint = canvas("fo-show-tint", 400, 200, 200)
		const piece = canvas("", 100, 100, 50)

		piece.style.width = "100%"
		layer.append(tint)
		host.append(piece)
		mirror.frame()
		drawn = []
		mirror.frame()
		mirror.frame()

		const sources = drawn.map(entry => entry.args[0])

		expect(sources.filter(source => source === tint)).toHaveLength(2)
		expect(sources.filter(source => source === piece)).toHaveLength(2)
		expect(sources.filter(source => source !== tint && source !== piece)).toHaveLength(0)
		// A piece without a CSS width in px is copied at the stage's ratio (2): half its pixels.
		expect([...target.querySelectorAll("canvas")].map(copy => (copy as HTMLCanvasElement).width)).toContain(50)
	})

	it("keeps a moved node's copy, and frees what left the stage", () => {
		const { host, slide, layer, bitmap } = stage()
		const { mirror, target } = mirrorOf(host)
		const copy = mirror.copyOf(bitmap) as HTMLCanvasElement
		const other = document.createElement("div")

		host.append(other)
		mirror.frame()
		drawn = []
		other.append(bitmap)
		mirror.frame()
		expect(mirror.copyOf(bitmap)).toBe(copy)
		expect(copy.parentElement).toBe(mirror.copyOf(other))
		expect(drawn).toHaveLength(0)

		layer.append(bitmap)
		slide.remove()
		mirror.frame()
		expect(target.querySelector(".fo-show-slide-box")).toBeNull()
		expect(mirror.copyOf(bitmap)).toBeUndefined()
		expect(copy.width).toBe(0)
	})

	it("draws a video at each frame it presents, letterboxed in its box, and stops with it", () => {
		const { host, layer } = stage()
		const { mirror, target } = mirrorOf(host)
		const box = document.createElement("div")
		const video = document.createElement("video")
		const callbacks: (() => void)[] = []
		const cancel = vi.fn()

		box.style.cssText = "position:absolute;width:160px;height:90px"
		Object.defineProperties(video, {
			videoWidth: { value: 90 },
			videoHeight: { value: 90 },
			readyState: { value: 4 },
			requestVideoFrameCallback: {
				value: (callback: () => void) => {
					callbacks.push(callback)

					return callbacks.length
				}
			},
			cancelVideoFrameCallback: { value: cancel }
		})
		box.append(video)
		layer.append(box)
		mirror.frame()
		drawn = []
		callbacks.at(-1)?.()

		const copy = target.querySelector<HTMLCanvasElement>(".fo-show-layer > div > canvas")

		expect(target.querySelector("video")).toBeNull()
		expect([copy?.width, copy?.height]).toEqual([160, 90])
		// 90 by 90 contained in 160 by 90: centred.
		expect(drawn.map(entry => entry.args)).toEqual([[video, 35, 0, 90, 90]])
		expect(callbacks).toHaveLength(2)

		box.remove()
		mirror.frame()
		expect(cancel).toHaveBeenCalledWith(2)
	})

	it("lets go of the stage when released", () => {
		const { host, layer } = stage()
		const { mirror, target } = mirrorOf(host)

		mirror.release()
		layer.style.opacity = "0.25"
		mirror.frame()
		expect(target.childNodes).toHaveLength(0)
	})
})

describe("ShowMirrorLink", () => {
	function controller(): { controller: ShowController; made: HTMLElement[]; released: number[] } {
		const made: HTMLElement[] = []
		const released: number[] = []
		const value = {
			mirror: (target: HTMLElement): ShowMirror => {
				const id = made.push(target)

				return { resize: () => undefined, release: () => released.push(id) }
			}
		} as unknown as ShowController

		return { controller: value, made, released }
	}

	it("makes one copy once both the controller and the view are there, in either order", () => {
		const a = controller()
		const link = new ShowMirrorLink()
		const target = document.createElement("div")

		link.connect(a.controller)
		expect(a.made).toHaveLength(0)
		link.view(target, 1)
		expect(a.made).toEqual([target])
		link.resize(2)
		expect(a.made).toHaveLength(1)
		link.view(undefined)
		expect(a.released).toEqual([1])
	})

	it("keeps the copy across a ref detached and attached again in one commit, and moves to a new controller", async () => {
		const a = controller()
		const b = controller()
		const link = new ShowMirrorLink()

		link.view(document.createElement("div"), 1)
		link.connect(a.controller)
		link.disconnect(a.controller)
		link.connect(a.controller)
		await Promise.resolve()
		expect(a.made).toHaveLength(1)
		expect(a.released).toEqual([])

		link.connect(b.controller)
		link.disconnect(a.controller)
		expect(a.released).toEqual([1])
		expect(b.made).toHaveLength(1)

		link.disconnect(b.controller)
		await Promise.resolve()
		expect(b.released).toEqual([1])
	})
})
