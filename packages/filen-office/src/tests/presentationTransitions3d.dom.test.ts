// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Transition } from "../core/anim/model"
import { cutSlide, transitions3d, type Transition3dContext } from "../react/presentation/show/transitions3d"

// The 3D transition renderer on the player's two slide boxes: refused without CSS 3D (the player then plays the
// file's fallback), a one-piece-per-slide transition moving the live boxes only, a cut transition drawing its
// further pieces cut from the slide box within the bitmap budget, a cut refused when the slide holds what a canvas
// cannot copy, the first and last frames as the slides stand, and every box restored and every canvas freed at the
// end. happy-dom has no canvas: a recording 2D context stands in.

const SLIDE = { w: 1280, h: 720 }

type Call = readonly [string, ...unknown[]]

class Context2d {
	readonly calls: Call[] = []
	globalAlpha = 1
	fillStyle = ""

	setTransform(...args: number[]): void {
		this.calls.push(["setTransform", ...args])
	}

	transform(...args: number[]): void {
		this.calls.push(["transform", ...args])
	}

	fillRect(...args: number[]): void {
		this.calls.push(["fillRect", ...args])
	}

	save(): void {
		this.calls.push(["save"])
	}

	restore(): void {
		this.calls.push(["restore"])
	}

	clip(path: unknown, rule: string): void {
		this.calls.push(["clip", path, rule])
	}

	drawImage(source: unknown, ...args: number[]): void {
		this.calls.push(["drawImage", source, this.globalAlpha, ...args])
	}
}

const contexts = new Map<HTMLCanvasElement, Context2d>()
let supports3d = true

function transition(kind: string, namespace: Transition["namespace"], options: Transition["options"] = {}): Transition {
	return { kind, namespace, options, durationMs: 1000, advance: { onClick: true } }
}

function bitmapCanvas(x: number, y: number, w: number, h: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas")

	canvas.className = "fo-show-bitmap"
	canvas.width = w * 2
	canvas.height = h * 2
	canvas.style.cssText = `position:absolute;left:${String(x)}px;top:${String(y)}px;width:${String(w)}px;height:${String(h)}px`

	return canvas
}

// A slide box as the stage builds it: a white box, a base bitmap and a layer with one shape's bitmap.
function slideBox(): HTMLDivElement {
	const box = document.createElement("div")

	box.className = "fo-show-slide-box"
	box.style.cssText = `position:absolute;left:0;top:0;width:${String(SLIDE.w)}px;height:${String(SLIDE.h)}px;overflow:hidden;background:#fff`
	box.style.zIndex = "1"
	box.appendChild(bitmapCanvas(0, 0, SLIDE.w, SLIDE.h))

	const layer = document.createElement("div")

	layer.className = "fo-show-layer"
	layer.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0"
	layer.style.transform = "matrix(1,0,0,1,40,30)"
	layer.style.opacity = "0.5"
	layer.appendChild(bitmapCanvas(100, 100, 200, 100))
	box.appendChild(layer)

	return box
}

function stage(): { host: HTMLDivElement; outgoing: HTMLDivElement; incoming: HTMLDivElement } {
	const host = document.createElement("div")
	const outgoing = slideBox()
	const incoming = slideBox()

	host.append(outgoing, incoming)
	document.body.appendChild(host)

	return { host, outgoing, incoming }
}

function context(parts: ReturnType<typeof stage>, t: Transition, budgetBytes = 256 * 1024 * 1024): Transition3dContext {
	return {
		document,
		host: parts.host,
		outgoing: parts.outgoing,
		incoming: parts.incoming,
		transition: t,
		slide: SLIDE,
		pixelRatio: 2,
		budgetBytes
	}
}

function inlineStyles(element: HTMLElement): string {
	return element.style.cssText
}

beforeEach(() => {
	supports3d = true
	vi.stubGlobal("CSS", {
		supports: (property: string, value: string) => supports3d && property === "transform" && value.startsWith("matrix3d(")
	})
	vi.stubGlobal(
		"Path2D",
		class {
			readonly d: string

			constructor(d: string) {
				this.d = d
			}
		}
	)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		let held = contexts.get(this)

		if (held === undefined) {
			held = new Context2d()
			contexts.set(this, held)
		}

		return held as unknown as CanvasRenderingContext2D
	} as unknown as typeof HTMLCanvasElement.prototype.getContext)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	contexts.clear()
	document.body.innerHTML = ""
})

describe("3D transitions: the renderer", () => {
	it("draws the p14 3D set and the p15 presets only", () => {
		expect(transitions3d.draws("flip", "p14")).toBe(true)
		expect(transitions3d.draws("origami", "p15")).toBe(true)
		expect(transitions3d.draws("fade", "p")).toBe(false)
		expect(transitions3d.draws("vortex", "p14")).toBe(false)
	})

	it("refuses without CSS 3D, leaving the slide boxes as they were (the player plays the fallback)", () => {
		supports3d = false

		const parts = stage()
		const before = [inlineStyles(parts.outgoing), inlineStyles(parts.incoming)]

		expect(transitions3d.start(context(parts, transition("flip", "p14")))).toBeUndefined()
		expect([inlineStyles(parts.outgoing), inlineStyles(parts.incoming)]).toEqual(before)
		expect(parts.host.children.length).toBe(2)
	})

	it("turns the live boxes for a flip, hiding the side turned away, and restores them at the end", () => {
		const parts = stage()
		const before = [inlineStyles(parts.outgoing), inlineStyles(parts.incoming)]
		const run = transitions3d.start(context(parts, transition("flip", "p14")))

		if (run === undefined) throw new Error("refused")

		// A flip cuts nothing: no canvas made, nothing added beside the boxes.
		expect(parts.host.querySelectorAll(".fo-show-piece").length).toBe(0)

		run.frame(0.25)
		expect(parts.outgoing.style.transform).toMatch(/^matrix3d\(/u)
		expect(parts.outgoing.style.visibility).toBe("visible")
		expect(parts.incoming.style.visibility).toBe("hidden")

		run.frame(0.75)
		expect(parts.outgoing.style.visibility).toBe("hidden")
		expect(parts.incoming.style.visibility).toBe("visible")
		expect(parts.incoming.style.transform).toMatch(/^matrix3d\(/u)

		// The first frame is the outgoing slide as it stands.
		run.frame(0)
		expect(parts.outgoing.style.transform).toBe("")
		expect(parts.outgoing.style.visibility).toBe("visible")
		expect(parts.incoming.style.visibility).toBe("hidden")

		run.finish()
		expect([inlineStyles(parts.outgoing), inlineStyles(parts.incoming)]).toEqual(before)
		expect(parts.host.querySelectorAll(".fo-show-shade").length).toBe(0)
	})

	it("cuts doors from the slide box: one half is the live box clipped, the other a canvas, both freed at the end", () => {
		const parts = stage()
		const run = transitions3d.start(context(parts, transition("doors", "p14", { dir: "vert" })))

		if (run === undefined) throw new Error("refused")

		const pieces = [...parts.host.querySelectorAll<HTMLElement>(".fo-show-piece")]

		expect(pieces.length).toBe(1)
		// Cut in the first frame (the canvas work runs in slices of frames, never in the start).
		expect(contexts.size).toBe(0)
		run.frame(0.01)

		const canvas = pieces[0]?.querySelector("canvas")

		// The right half (640 px wide, plus its overlap) at the screen's 2 device px per slide px.
		expect(canvas?.width).toBe(Math.round((640 + 1.5) * 2))
		expect(canvas?.height).toBe(Math.round((720 + 1.5) * 2))
		// Drawn from the box's bitmaps (the layer's at half opacity), offset to the half's bounds.
		const calls = contexts.get(canvas as HTMLCanvasElement)?.calls ?? []

		expect(calls[0]).toEqual(["setTransform", 2, 0, 0, 2, -(640 - 0.75) * 2, 0.75 * 2])
		expect(calls.filter(call => call[0] === "drawImage").map(call => call[2])).toEqual([1, 0.5])

		run.frame(0.5)
		expect(parts.outgoing.style.clipPath).toMatch(/^path\("M0 0L640 0L640 720L0 720Z"\)$/u)
		expect(pieces[0]?.style.transform).toMatch(/^matrix3d\(/u)
		expect(Number(pieces[0]?.style.zIndex)).toBeGreaterThan(Number(parts.incoming.style.zIndex))

		run.finish()
		expect(parts.host.querySelectorAll(".fo-show-piece").length).toBe(0)
		expect(canvas?.width).toBe(0)
		expect(parts.outgoing.style.clipPath).toBe("")
		expect(parts.outgoing.style.zIndex).toBe("1")
	})

	it("cuts smaller within the bitmap budget, and refuses below half the screen's resolution", () => {
		const parts = stage()
		// The cut half at 1 device px per slide px.
		const unit = 641.5 * 721.5 * 4
		const run = transitions3d.start(context(parts, transition("doors", "p14", { dir: "vert" }), unit * 1.05))

		if (run === undefined) throw new Error("refused")

		const canvas = parts.host.querySelector<HTMLCanvasElement>(".fo-show-piece canvas")

		run.frame(0.01)
		expect(canvas?.width).toBe(Math.round(641.5 * Math.sqrt(1.05)))
		run.finish()

		const refused = transitions3d.start(context(stage(), transition("doors", "p14", { dir: "vert" }), unit * 0.2))

		expect(refused).toBeUndefined()
		expect(document.querySelectorAll(".fo-show-piece").length).toBe(0)
	})

	it("refuses a cut transition when the slide shows a DOM-painted layer, and takes it when that layer is hidden", () => {
		const parts = stage()
		const dom = document.createElement("div")

		dom.className = "fo-show-dom"
		parts.outgoing.appendChild(dom)

		expect(transitions3d.start(context(parts, transition("fracture", "p15")))).toBeUndefined()
		expect(parts.host.querySelectorAll(".fo-show-piece").length).toBe(0)

		dom.style.display = "none"

		const run = transitions3d.start(context(parts, transition("fracture", "p15")))

		expect(run).toBeDefined()
		// 48 shards; the first is the live box.
		expect(parts.host.querySelectorAll(".fo-show-piece").length).toBe(47)
		run?.finish()
	})

	it("cuts a fracture's shards over several frames, showing the outgoing slide until they are cut", () => {
		const parts = stage()
		const run = transitions3d.start(context(parts, transition("fracture", "p15")))

		if (run === undefined) throw new Error("refused")

		let now = 0

		vi.spyOn(performance, "now").mockImplementation(() => (now += 1))
		// Six steps of a 1 ms clock fit a slice: six shards.
		expect(run.frame(0.3)).toBe(true)
		expect(parts.outgoing.style.visibility).toBe("visible")
		expect(parts.outgoing.style.transform).toBe("")
		expect([...parts.host.querySelectorAll<HTMLElement>(".fo-show-piece")].every(piece => piece.style.visibility === "hidden")).toBe(
			true
		)

		for (let k = 0; k < 10; k++) run.frame(0.4)

		expect(parts.host.querySelectorAll<HTMLElement>(".fo-show-piece")[0]?.style.transform).toMatch(/^matrix3d\(/u)
		run.finish()
	})

	it("stops drawing when a piece's canvas cannot be had (the player plays the fallback from there)", () => {
		const parts = stage()
		const run = transitions3d.start(context(parts, transition("doors", "p14")))

		if (run === undefined) throw new Error("refused")

		vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
		expect(run.frame(0.2)).toBe(false)
		run.finish()
		expect(parts.host.querySelectorAll(".fo-show-piece").length).toBe(0)
	})

	it("turns only the content in a content-only prism: the backdrops stay, the incoming one fading in", () => {
		const parts = stage()

		for (const box of [parts.outgoing, parts.incoming]) {
			const base = box.querySelector("canvas")

			if (base !== null) base.dataset["foShowShape"] = "-2"
		}

		const run = transitions3d.start(context(parts, transition("prism", "p14", { isContent: true })))

		if (run === undefined) throw new Error("refused")

		const backdrops = [...parts.host.querySelectorAll<HTMLElement>(".fo-show-backdrop")]

		// Each box's backdrop canvas moved out for the run (nothing copied), the boxes showing their content only.
		expect(backdrops.map(backdrop => backdrop.querySelector("canvas")?.dataset["foShowShape"])).toEqual(["-2", "-2"])
		expect(parts.outgoing.querySelector('canvas[data-fo-show-shape="-2"]')).toBeNull()
		expect([parts.outgoing.style.background, parts.incoming.style.background]).toEqual(["transparent", "transparent"])

		run.frame(0)
		expect(backdrops.map(backdrop => backdrop.style.visibility)).toEqual(["visible", "hidden"])
		expect(parts.outgoing.style.visibility).toBe("visible")

		run.frame(0.5)
		expect(backdrops.map(backdrop => backdrop.style.visibility)).toEqual(["visible", "visible"])
		expect(Number(backdrops[1]?.style.opacity)).toBeCloseTo(0.5, 5)
		// The backdrops under both turning faces, which are not where they stand.
		const top = Math.max(...backdrops.map(backdrop => Number(backdrop.style.zIndex)))

		expect(Number(parts.outgoing.style.zIndex)).toBeGreaterThan(top)
		expect(Number(parts.incoming.style.zIndex)).toBeGreaterThan(top)
		expect(parts.outgoing.style.transform).toMatch(/^matrix3d\(/u)

		run.finish()
		expect(parts.outgoing.firstElementChild?.getAttribute("data-fo-show-shape")).toBe("-2")
		expect(parts.incoming.firstElementChild?.getAttribute("data-fo-show-shape")).toBe("-2")
		expect(parts.outgoing.style.background).not.toBe("transparent")
		expect(parts.host.querySelectorAll(".fo-show-backdrop, .fo-show-shade").length).toBe(0)
	})

	it("turns whole slides in a content-only prism when their backdrop is not drawn apart", () => {
		const parts = stage()
		const run = transitions3d.start(context(parts, transition("prism", "p14", { isContent: true })))

		if (run === undefined) throw new Error("refused")

		expect(parts.host.querySelectorAll(".fo-show-backdrop").length).toBe(0)
		expect(parts.outgoing.style.background).not.toBe("transparent")
		run.frame(0.5)
		expect(parts.outgoing.style.transform).toMatch(/^matrix3d\(/u)
		run.finish()
	})

	it("ends on the incoming slide as it stands and shows a peeled flap's back", () => {
		const parts = stage()
		const run = transitions3d.start(context(parts, transition("peelOff", "p15")))

		if (run === undefined) throw new Error("refused")

		run.frame(0.6)
		run.frame(0.6)

		const flap = parts.host.querySelector<HTMLElement>(".fo-show-piece")

		expect(flap?.style.visibility).toBe("visible")
		expect(flap?.style.clipPath).toMatch(/^path\(/u)

		run.frame(1)
		expect(parts.incoming.style.visibility).toBe("visible")
		expect(parts.incoming.style.transform).toBe("")
		expect(parts.outgoing.style.visibility).toBe("hidden")
		expect(flap?.style.visibility).toBe("hidden")
		run.finish()
	})
})

describe("3D transitions: cutting the slide box", () => {
	it("draws visible bitmaps through their layers' transform, opacity and clip, leaving out hidden ones and hotspots", () => {
		const box = slideBox()
		const hidden = document.createElement("div")

		hidden.className = "fo-show-layer"
		hidden.style.visibility = "hidden"
		hidden.appendChild(bitmapCanvas(0, 0, 10, 10))
		box.appendChild(hidden)

		const clipped = document.createElement("div")

		clipped.className = "fo-show-layer"
		clipped.style.clipPath = 'path(evenodd, "M0 0L10 0L10 10Z")'
		clipped.appendChild(bitmapCanvas(5, 5, 10, 10))

		const hotspot = document.createElement("button")

		hotspot.className = "fo-slide-hotspot"
		clipped.appendChild(hotspot)
		box.appendChild(clipped)

		const gone = document.createElement("div")

		gone.className = "fo-show-layer"
		gone.style.clipPath = "inset(50% 50% 50% 50%)"
		gone.appendChild(bitmapCanvas(0, 0, 10, 10))
		box.appendChild(gone)
		document.body.appendChild(box)

		const cut = cutSlide(box, { x: 0, y: 0, w: SLIDE.w, h: SLIDE.h }, 1.5)

		if (cut === undefined) throw new Error("refused")

		expect([cut.width, cut.height]).toEqual([1920, 1080])

		const calls = contexts.get(cut)?.calls ?? []

		expect(calls[0]).toEqual(["setTransform", 1.5, 0, 0, 1.5, 0, 0])
		expect(calls.filter(call => call[0] === "drawImage").map(call => call.slice(2))).toEqual([
			[1, 0, 0, 1280, 720],
			[0.5, 100, 100, 200, 100],
			[1, 5, 5, 10, 10]
		])
		expect(calls.find(call => call[0] === "transform")).toEqual(["transform", 1, 0, 0, 1, 40, 30])
		expect(calls.find(call => call[0] === "clip")?.[2]).toBe("evenodd")
	})

	it("draws a video's current frame fitted in its media box and refuses audio controls", () => {
		const box = slideBox()
		const media = document.createElement("div")
		const video = document.createElement("video")

		media.className = "fo-show-media"
		media.style.cssText = "position:absolute;left:0;top:0;width:400px;height:200px;transform:matrix(1,0,0,1,10,20)"
		Object.defineProperties(video, {
			readyState: { value: 4 },
			videoWidth: { value: 200 },
			videoHeight: { value: 200 }
		})
		media.appendChild(video)
		box.appendChild(media)

		const calls = contexts.get(cutSlide(box, { x: 0, y: 0, w: SLIDE.w, h: SLIDE.h }, 1) as HTMLCanvasElement)?.calls ?? []

		expect(
			calls
				.filter(call => call[0] === "drawImage")
				.at(-1)
				?.slice(2)
		).toEqual([1, 100, 0, 200, 200])

		const audio = document.createElement("audio")

		audio.controls = true
		media.appendChild(audio)
		expect(cutSlide(box, { x: 0, y: 0, w: SLIDE.w, h: SLIDE.h }, 1)).toBeUndefined()
	})
})
