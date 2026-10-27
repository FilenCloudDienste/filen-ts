import type { LayerState } from "../../../core/anim/model"
import type { DocxLinkTarget } from "../../../core/docx/layout/pageData"
import type { Action } from "../../../core/presentation/model"
import type { SlideLayer, SlideRender } from "../../../core/presentation/output"
import type { PresentationSessionApi, ShowLayer } from "../../../dom/presentation/protocol"
import { EMPTY_DRAWING, layerCss, type LayerCss, type LayerNode } from "./layers"
import type { PaintedSlide, SlidePainter } from "../SlideView"
import { linkBoxes, matrixCss } from "./links"

// One slide on the stage as DOM: a box at slide px (the stage scales it) holding the worker's layer bitmaps, each on a
// canvas at its bounds, nested in layer elements at the slide's origin (transform-origin 0 0) that carry the sampled
// transform, opacity, visibility and filter clip of their layer, so a frame changes only compositor properties. Click
// targets (actions, animation triggers, text links, media boxes) sit in the layer element of the shape they belong
// to and move, fade and hide with it.

// Media in the show (show/media.ts implements it; the player takes it as a prop).
export interface ShowMediaEvents {
	ended(): void
	bookmark(name: string): void
}

export interface ShowMediaHandle {
	// From the timegraph (LayerState.media) when it changes.
	command(command: NonNullable<LayerState["media"]>): void
	// A click on the media shape no trigger took.
	click(): void
	release(): void
}

export interface ShowMediaMount {
	// Once per media layer of a slide on stage, `box` an element over the layer (slide px, scaled by the stage).
	mount(box: HTMLElement, layer: SlideLayer, session: PresentationSessionApi | undefined, events: ShowMediaEvents): ShowMediaHandle
}

// What the click targets do (the player wires them).
export interface StageTargets {
	readonly action: (action: Action, layer: SlideLayer, event: MouseEvent) => void
	readonly trigger: (shape: number) => void
	readonly link: (link: DocxLinkTarget, layer: SlideLayer, event: MouseEvent) => void
	readonly media?: ShowMediaMount
	readonly session: PresentationSessionApi | undefined
	readonly mediaEvents: (shape: number) => ShowMediaEvents
	readonly labels: {
		readonly action: (action: Action, layer: SlideLayer) => string
		readonly trigger: (layer: SlideLayer) => string
		readonly link: (link: DocxLinkTarget) => string
	}
}

export interface StageSlide {
	readonly element: HTMLDivElement
	// Per timegraph layer, its elements.
	readonly layers: readonly (readonly HTMLElement[])[]
	// Bitmap bytes held (width x height x 4 per canvas).
	readonly bytes: number
	// The media of the slide by shape id (mounted with the targets).
	readonly media: ReadonlyMap<number, ShowMediaHandle>
	// Places the click targets of a render (again: the previous ones are removed).
	targets(render: SlideRender, owner: (layer: SlideLayer) => number, triggers: ReadonlySet<number>, targets: StageTargets): void
	// The layers whose colours or text style animate, painted again as DOM (the SVG compositor's) for the frames that
	// change them; `base` the point size the layer's text is drawn at (a font-size frame scales by sampled / base).
	paintDom(
		render: SlideRender,
		owner: (layer: SlideLayer) => number,
		layers: ReadonlySet<number>,
		painter: SlidePainter,
		session: PresentationSessionApi | undefined
	): void
	// Applies sampled states (by timegraph layer); layers without one are as drawn.
	apply(states: readonly LayerState[], boxes: Float64Array): void
	release(): void
}

// 1 px, not 0: WebKit drops the opacity of a composited element with no area (its children's included).
const LAYER_STYLE = "position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0"

function layerElement(document: Document, layer: number): HTMLDivElement {
	const element = document.createElement("div")

	element.className = "fo-show-layer"
	element.style.cssText = LAYER_STYLE
	element.dataset["foShowLayer"] = String(layer)

	return element
}

// Draws a transferred bitmap on a canvas at its bounds (slide px).
function canvasOf(document: Document, layer: ShowLayer): HTMLCanvasElement {
	const canvas = document.createElement("canvas")

	canvas.className = "fo-show-bitmap"
	canvas.width = layer.bitmap.width
	canvas.height = layer.bitmap.height
	canvas.style.cssText = `position:absolute;left:${String(layer.x)}px;top:${String(layer.y)}px;width:${String(layer.width)}px;height:${String(layer.height)}px`

	// Drawn once and closed (a "bitmaprenderer" canvas that takes the bitmap over is sometimes never painted by WebKit
	// when it first shows after being hidden).
	canvas.getContext("2d")?.drawImage(layer.bitmap as unknown as ImageBitmap, 0, 0)
	layer.bitmap.close()

	return canvas
}

function setCss(element: HTMLElement, previous: LayerCss | undefined, next: LayerCss): void {
	if (previous?.transform !== next.transform) element.style.transform = next.transform
	if (previous?.opacity !== next.opacity) element.style.opacity = next.opacity
	if (previous?.visibility !== next.visibility) element.style.visibility = next.visibility === "visible" ? "" : "hidden"
	if (previous?.clipPath !== next.clipPath) element.style.clipPath = next.clipPath
}

function cssColor(rgba: number): string {
	return `#${(rgba >>> 0).toString(16).padStart(8, "0")}`
}

// Shows a layer's DOM paint in place of its bitmaps while a state changes its colours or text style, with the
// sampled values as the custom properties presentation.css applies (fills, strokes, text colour, weight, style,
// underline, and a font size as each run scaled about its baseline start).
function domState(
	dom: { readonly element: HTMLElement; readonly base: number; key: string },
	state: LayerState | undefined,
	host: HTMLElement | undefined
): void {
	const values = state?.dom
	const scale = state?.fontSize !== undefined && dom.base > 0 ? state.fontSize / dom.base : undefined
	const on = values !== undefined || scale !== undefined
	const key = on ? JSON.stringify([values, scale]) : ""

	if (key === dom.key) return

	dom.key = key

	const style = dom.element.style
	const data = dom.element.dataset
	const set = (name: string, flag: string, value: string | undefined): void => {
		if (value === undefined) {
			style.removeProperty(name)
			delete data[flag]
		} else {
			style.setProperty(name, value)
			data[flag] = ""
		}
	}

	style.display = on ? "" : "none"

	// The layer's bitmaps step aside while its DOM paint (the shape's whole text) shows, its nested paragraph ranges'
	// and by-letter runs' too (tinted ones included).
	for (const canvas of host?.querySelectorAll<HTMLCanvasElement>("canvas.fo-show-bitmap, canvas.fo-show-tint") ?? [])
		canvas.style.visibility = on ? "hidden" : ""

	set("--fo-show-fill", "foFill", values?.fill === undefined ? undefined : cssColor(values.fill))
	set("--fo-show-stroke", "foStroke", values?.stroke === undefined ? undefined : cssColor(values.stroke))
	set("--fo-show-color", "foColor", values?.textColor === undefined ? undefined : cssColor(values.textColor))
	set("--fo-show-weight", "foWeight", values?.fontWeight === undefined ? undefined : String(values.fontWeight))
	set("--fo-show-italic", "foItalic", values?.fontStyle === "italic" ? "italic" : undefined)
	set("--fo-show-underline", "foUnderline", values?.underline === true ? "underline" : undefined)
	set("--fo-show-font-scale", "foFontScale", scale === undefined ? undefined : String(scale))
}

// The slide box of drawn `layers` nested as `tree`, for a timegraph of `layerCount` layers.
export function buildStageSlide(
	document: Document,
	slide: { readonly w: number; readonly h: number },
	layers: readonly ShowLayer[],
	tree: LayerNode,
	layerCount: number
): StageSlide {
	const element = document.createElement("div")
	const byLayer: HTMLElement[][] = Array.from({ length: layerCount }, () => [])
	const canvases: HTMLCanvasElement[] = []
	let bytes = 0

	element.className = "fo-show-slide-box"
	element.dataset["foShowSlide"] = ""
	element.style.cssText = `position:absolute;left:0;top:0;width:${String(slide.w)}px;height:${String(slide.h)}px;overflow:hidden;background:#fff`

	const build = (node: LayerNode, host: HTMLElement): void => {
		for (const child of node.children) {
			if (typeof child === "number") {
				const layer = layers[child]

				if (layer === undefined) continue

				// Counted before the canvas takes the bitmap over (a transferred bitmap reads 0 by 0).
				bytes += layer.bitmap.width * layer.bitmap.height * 4

				const canvas = canvasOf(document, layer)

				canvases.push(canvas)
				host.appendChild(canvas)

				continue
			}

			const made = layerElement(document, child.layer)

			byLayer[child.layer]?.push(made)
			host.appendChild(made)
			build(child, made)
		}
	}

	build(tree, element)

	const applied = new Map<HTMLElement, LayerCss>()
	// Per layer without a DOM paint (a by-letter or by-word run: its glyphs only) whose text colour animates: its
	// bitmaps with a tinted copy over each, and the colour on them ("" as drawn).
	const tints = new Map<number, { key: string; readonly pairs: [HTMLCanvasElement, HTMLCanvasElement | undefined][] }>()
	const tint = (index: number, color: number | undefined): void => {
		const key = color === undefined ? "" : String(color)
		let held = tints.get(index)

		if ((held?.key ?? "") === key) return

		const host = byLayer[index]?.[0]

		if (host === undefined) return

		if (held === undefined) {
			held = { key: "", pairs: [] }

			for (const child of host.children)
				if (child instanceof HTMLCanvasElement && child.classList.contains("fo-show-bitmap")) held.pairs.push([child, undefined])

			tints.set(index, held)
		}

		held.key = key

		for (const pair of held.pairs) {
			const [glyphs, copy] = pair

			if (color === undefined) {
				glyphs.style.visibility = ""

				if (copy !== undefined) copy.style.display = "none"

				continue
			}

			let tinted = copy

			if (tinted === undefined) {
				tinted = document.createElement("canvas")
				tinted.className = "fo-show-tint"
				tinted.width = glyphs.width
				tinted.height = glyphs.height
				tinted.style.cssText = glyphs.style.cssText
				glyphs.after(tinted)
				canvases.push(tinted)
				pair[1] = tinted
			}

			// The glyphs' coverage filled with the colour (a dim sets all of the run's text to one colour).
			const context = tinted.getContext("2d")

			if (context !== null) {
				context.globalCompositeOperation = "copy"
				context.drawImage(glyphs, 0, 0)
				context.globalCompositeOperation = "source-in"
				context.fillStyle = cssColor(color)
				context.fillRect(0, 0, tinted.width, tinted.height)
			}

			tinted.style.display = ""
			tinted.style.visibility = ""
			glyphs.style.visibility = "hidden"
		}
	}
	// Per layer with colour or text-style animation: its DOM paint, the point size of its text, what is set on it.
	const doms = new Map<number, { readonly painted: PaintedSlide; readonly element: HTMLElement; readonly base: number; key: string }>()
	let placed: HTMLElement[] = []
	let media = new Map<number, ShowMediaHandle>()

	const removeTargets = (): void => {
		for (const target of placed) target.remove()
		for (const handle of media.values()) handle.release()

		placed = []
		media = new Map()
	}

	return {
		element,
		layers: byLayer,
		bytes,
		get media() {
			return media
		},
		targets(render, owner, triggers, targets) {
			removeTargets()

			for (const layer of render.layers) {
				const index = owner(layer)
				const host = (index < 0 ? undefined : byLayer[index]?.[0]) ?? element
				const action = layer.actions?.click
				const shape = layer.box?.id ?? layer.shape.id
				const own = layer.shape.slide === render.ref

				const medium = own && "media" in layer && layer.media !== undefined

				if (!medium && (action !== undefined || (own && (triggers.has(layer.shape.id) || triggers.has(shape))))) {
					const button = document.createElement("button")

					button.type = "button"
					button.className = "fo-slide-hotspot"
					button.style.width = `${String(layer.drawing.width)}px`
					button.style.height = `${String(layer.drawing.height)}px`
					button.style.transform = matrixCss(layer.matrix)

					if (action !== undefined) {
						button.dataset["foAction"] = action.kind
						button.setAttribute("aria-label", targets.labels.action(action, layer))
						button.addEventListener("click", event => {
							event.stopPropagation()
							targets.action(action, layer, event)
						})
					} else {
						const id = triggers.has(layer.shape.id) ? layer.shape.id : shape

						button.dataset["foTrigger"] = String(id)
						button.setAttribute("aria-label", targets.labels.trigger(layer))
						button.addEventListener("click", event => {
							event.stopPropagation()
							targets.trigger(id)
						})
					}

					host.appendChild(button)
					placed.push(button)
				}

				const links = linkBoxes(layer)

				if (links.length > 0 && layer.text !== undefined) {
					const frame = document.createElement("div")
					const text = layer.text

					frame.className = "fo-show-links"
					frame.style.cssText = `${LAYER_STYLE};transform:${matrixCss(layer.textMatrix ?? layer.matrix)}`

					for (const box of links) {
						const target = text.links[box.link]

						if (target === undefined) continue

						const button = document.createElement("button")

						button.type = "button"
						button.className = "fo-slide-hotspot"
						button.dataset["foLink"] = String(box.link)
						button.style.left = `${String(box.x)}px`
						button.style.top = `${String(box.y)}px`
						button.style.width = `${String(box.width)}px`
						button.style.height = `${String(box.height)}px`
						button.setAttribute("aria-label", targets.labels.link(target))
						button.addEventListener("click", event => {
							event.stopPropagation()
							targets.link(target, layer, event)
						})
						frame.appendChild(button)
					}

					host.appendChild(frame)
					placed.push(frame)
				}

				if (medium && targets.media !== undefined && !media.has(layer.shape.id)) {
					const box = document.createElement("div")
					const id = layer.shape.id
					const handle = targets.media.mount(box, layer, targets.session, targets.mediaEvents(id))

					box.className = "fo-show-media"
					box.style.cssText = `${LAYER_STYLE};width:${String(layer.drawing.width)}px;height:${String(layer.drawing.height)}px;transform:${matrixCss(layer.matrix)}`
					// A click on a medium never advances the slide: it is the medium's trigger, else plays or pauses it.
					box.addEventListener("click", event => {
						event.stopPropagation()

						if (triggers.has(id) || triggers.has(shape)) targets.trigger(triggers.has(id) ? id : shape)
						else handle.click()
					})
					host.appendChild(box)
					placed.push(box)
					media.set(id, handle)
				}
			}
		},
		paintDom(render, owner, layers, painter, session) {
			for (const held of doms.values()) {
				held.painted.release()
				held.element.remove()
			}

			doms.clear()

			for (const index of layers) {
				const host = byLayer[index]?.[0]
				const own = render.layers.filter(layer => owner(layer) === index)

				if (host === undefined || own.length === 0) continue

				// The slide's box with nothing in it: the text keeps its place, and the paint lets the slide show through.
				const painted = painter(
					{
						...render,
						background: { ...EMPTY_DRAWING, width: render.background.width, height: render.background.height },
						layers: own
					},
					{ document, session, signal: { aborted: false } }
				)

				const root = painted.root

				// The stage's own realm: the show never runs in another window.
				if (root instanceof HTMLElement || root instanceof SVGElement) root.style.background = "transparent"

				const element = document.createElement("div")
				const font = own.find(layer => layer.text !== undefined)?.text?.styles[0]?.font ?? ""
				const px = Number(/(\d+(?:\.\d+)?)px/u.exec(font)?.[1] ?? Number.NaN)

				element.className = "fo-show-dom"
				element.style.cssText = `${LAYER_STYLE};display:none`
				element.appendChild(painted.root)
				host.appendChild(element)
				doms.set(index, { painted, element, base: px > 0 ? px * 0.75 : 0, key: "" })
			}
		},
		apply(states, boxes) {
			const seen = new Set<number>()

			for (const [index, dom] of doms) {
				const state = states.find(candidate => candidate.layer === index)

				domState(dom, state, byLayer[index]?.[0])
			}

			for (const state of states)
				if (state.dom?.textColor !== undefined && !doms.has(state.layer)) tint(state.layer, state.dom.textColor)

			for (const index of tints.keys())
				if (!states.some(state => state.layer === index && state.dom?.textColor !== undefined)) tint(index, undefined)

			for (const state of states) {
				seen.add(state.layer)

				const css = layerCss(state, {
					x: boxes[state.layer * 4] ?? 0,
					y: boxes[state.layer * 4 + 1] ?? 0,
					w: boxes[state.layer * 4 + 2] ?? 0,
					h: boxes[state.layer * 4 + 3] ?? 0
				})

				for (const target of byLayer[state.layer] ?? []) {
					setCss(target, applied.get(target), css)
					applied.set(target, css)
				}
			}

			// Layers no behaviour addresses at this time are as drawn.
			byLayer.forEach((targets, layer) => {
				if (seen.has(layer)) return

				const css = layerCss(undefined, { x: 0, y: 0, w: 0, h: 0 })

				for (const target of targets) {
					const previous = applied.get(target)

					if (previous === undefined) continue

					setCss(target, previous, css)
					applied.delete(target)
				}
			})
		},
		release() {
			removeTargets()

			for (const held of doms.values()) held.painted.release()

			doms.clear()

			// Frees the bitmaps' backing stores at once (an element removed is collected later).
			for (const canvas of canvases) {
				canvas.width = 0
				canvas.height = 0
			}

			element.remove()
		}
	}
}
