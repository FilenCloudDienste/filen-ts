import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react"
import { EMU_PER_PX } from "../../core/drawingml/index"
import type { Action } from "../../core/presentation/model"
import type { PresentationSessionApi, SlideLayer, SlideRender } from "../../dom/presentation/protocol"
import type { ActionTrigger, PresentationActionActivator } from "./links"

// One slide: a fixed-size paper at slide px, scaled by a CSS transform to fit the element (or to a zoom), white in
// both themes, painted by the compositor it is given. Click actions get a focusable hotspot over their shape; hover
// actions are never wired. Text links (paintPage's data-fo-link inside a layer's data-fo-layer) go through the
// same action policy, judged on click. In the editor the selection layer lies over the slide, so a Mod+click is
// matched to the link or hotspot under its point.

export interface SlidePaintContext {
	readonly document: Document
	readonly session: PresentationSessionApi | undefined
	readonly signal: { readonly aborted: boolean }
}

// The compositor's result. Its root is drawn at slide px; each layer's outermost element carries
// data-fo-layer = its index in render.layers, and text links keep paintPage's data-fo-link (an index into that
// layer's TextPage.links).
export interface PaintedSlide {
	readonly root: Element
	release(): void
}

export type SlidePainter = (render: SlideRender, context: SlidePaintContext) => PaintedSlide

export interface SlideViewProps {
	readonly render: SlideRender | undefined
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	readonly painter: SlidePainter
	readonly session?: PresentationSessionApi
	readonly label: string
	// 1 = slide px; absent: fit inside the element.
	readonly zoom?: number
	readonly mode?: "view" | "show" | "edit"
	readonly actions?: PresentationActionActivator
	readonly actionLabel?: (action: Action, layer: SlideLayer) => string
	readonly onScale?: (scale: number) => void
	readonly className?: string
	readonly ref?: Ref<HTMLDivElement>
	// Drawn over the slide inside its frame, at screen px (the frame's own size; it is positioned relative). The
	// editor's selection layer.
	readonly overlay?: ReactNode
}

// Mod: Cmd on Apple platforms, Ctrl elsewhere.
function modifierOf(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
	const platform: unknown = Reflect.get(Reflect.get(globalThis, "navigator") ?? {}, "platform")
	const apple = typeof platform === "string" && /Mac|iPhone|iPad/u.test(platform)

	return apple ? event.metaKey : event.ctrlKey
}

// The layer box on the slide: the drawing's extent under the layer matrix (CSS matrix()).
function hotspotStyle(layer: SlideLayer): { width: number; height: number; transform: string } {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix

	return {
		width: layer.drawing.width,
		height: layer.drawing.height,
		transform: `matrix(${String(a)},${String(b)},${String(c)},${String(d)},${String(e)},${String(f)})`
	}
}

// ---- the painted slide across renders ----

// One painter call: the layers it painted still shown keep it (its pictures) until the last of them goes.
interface Batch {
	readonly painted: PaintedSlide
	readonly signal: { aborted: boolean }
	live: number
}

interface ShownLayer {
	readonly element: HTMLElement
	readonly batch: Batch
	readonly layer: SlideLayer
	// The transform as the element reads it back once set here (another one there is someone else's: a drag's preview).
	transform: string
}

interface Shown {
	readonly root: Element
	readonly painter: SlidePainter
	readonly session: PresentationSessionApi | undefined
	readonly batch: Batch
	render: SlideRender
	layers: ShownLayer[]
}

function paintBatch(host: HTMLElement, render: SlideRender, painter: SlidePainter, session: PresentationSessionApi | undefined): Batch {
	const signal = { aborted: false }

	return { painted: painter(render, { document: host.ownerDocument, session, signal }), signal, live: 0 }
}

// The painter's layer elements of a painted root, in render order (each carries data-fo-layer).
function layerElements(root: Element): HTMLElement[] {
	const out: HTMLElement[] = []

	for (const child of root.children) if (child instanceof HTMLElement && child.dataset["foLayer"] !== undefined) out.push(child)

	return out
}

function paintShown(host: HTMLElement, render: SlideRender, painter: SlidePainter, session: PresentationSessionApi | undefined): Shown {
	const batch = paintBatch(host, render, painter, session)
	const elements = layerElements(batch.painted.root)
	const layers: ShownLayer[] = []

	render.layers.forEach((layer, index) => {
		const element = elements[index]

		if (element !== undefined) layers.push({ element, batch, layer, transform: element.style.transform })
	})

	batch.live = 1 + layers.length
	host.replaceChildren(batch.painted.root)

	return { root: batch.painted.root, painter, session, batch, render, layers }
}

function releaseBatch(batch: Batch, count = 1): void {
	batch.live -= count

	if (batch.live > 0) return

	batch.signal.aborted = true
	batch.painted.release()
}

function releaseShown(shown: Shown, host: HTMLElement): void {
	const batches = new Set<Batch>([shown.batch, ...shown.layers.map(layer => layer.batch)])

	for (const batch of batches) {
		batch.live = 0
		batch.signal.aborted = true
		batch.painted.release()
	}

	host.replaceChildren()
}

// Two values alike to the painter (typed arrays by their elements, NaN alike).
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b)
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false

	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false

		const left = a as unknown as ArrayLike<number>
		const right = b as unknown as ArrayLike<number>

		if (left.length !== right.length) return false

		for (let k = 0; k < left.length; k++) if (left[k] !== right[k] && !(Number.isNaN(left[k]) && Number.isNaN(right[k]))) return false

		return true
	}

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

		return a.every((item: unknown, k) => sameValue(item, b[k]))
	}

	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false

		for (const [key, value] of a) if (!b.has(key) || !sameValue(value, b.get(key))) return false

		return true
	}

	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = Object.keys(left)

	if (keys.length !== Object.keys(right).length) return false

	return keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

// The text matrix relative to the layer's (where the painter places the text inside the layer box), or undefined when
// the layer's matrix cannot be inverted (the painter then places each part on its own).
function relativeText(layer: SlideLayer): number[] | undefined {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix
	const det = a * d - b * c

	if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return undefined

	const inverse = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
	const [p = 1, q = 0, r = 0, s = 1, t = 0, u = 0] = layer.textMatrix ?? layer.matrix
	const [ia = 1, ib = 0, ic = 0, id = 1, ie = 0, iff = 0] = inverse

	return [ia * p + ic * q, ib * p + id * q, ia * r + ic * s, ib * r + id * s, ia * t + ic * u + ie, ib * t + id * u + iff]
}

function sameRelative(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
	if (a === undefined || b === undefined) return false

	return a.every((value, k) => Math.abs(value - (b[k] ?? Number.NaN)) <= 1e-6)
}

// Whether a layer paints as another, its place on the slide aside.
function paintsAlike(a: SlideLayer, b: SlideLayer): boolean {
	return (
		sameValue(a.drawing, b.drawing) &&
		sameValue(a.text, b.text) &&
		sameValue(a.prompt, b.prompt) &&
		sameValue(a.effects, b.effects) &&
		a.alt === b.alt &&
		sameRelative(relativeText(a), relativeText(b))
	)
}

function layerKey(layer: SlideLayer): string {
	return `${String(layer.shape.slide)}:${String(layer.shape.id)}:${layer.role}`
}

function cssMatrixOf(matrix: readonly number[]): string {
	return `matrix(${[0, 1, 2, 3, 4, 5].map(k => String(Math.round((matrix[k] ?? 0) * 10000) / 10000)).join(",")})`
}

// `render` shown by updating `shown` in place; false when it cannot be (another slide, another background).
function updateShown(shown: Shown, render: SlideRender): boolean {
	if (render.ref !== shown.render.ref || !sameValue(render.background, shown.render.background)) return false

	const pool = new Map<string, ShownLayer[]>()

	for (const entry of shown.layers) {
		const key = layerKey(entry.layer)
		const list = pool.get(key)

		if (list === undefined) pool.set(key, [entry])
		else list.push(entry)
	}

	const kept: (ShownLayer | undefined)[] = []
	const fresh: SlideLayer[] = []

	for (const layer of render.layers) {
		const list = pool.get(layerKey(layer))
		const at = list?.findIndex(entry => paintsAlike(entry.layer, layer)) ?? -1
		const entry = at >= 0 ? list?.splice(at, 1)[0] : undefined
		const moved = entry !== undefined && !sameValue(entry.layer.matrix, layer.matrix)

		// A layer someone else transformed (a drag's preview) is painted again rather than moved under it.
		if (entry === undefined || (moved && entry.element.style.transform !== entry.transform)) {
			if (entry !== undefined) list?.push(entry)

			kept.push(undefined)
			fresh.push(layer)

			continue
		}

		if (moved) {
			entry.element.style.transform = cssMatrixOf(layer.matrix)
			entry.transform = entry.element.style.transform
		}

		kept.push({ ...entry, layer })
	}

	const host = shown.root
	const batch =
		fresh.length === 0 ? undefined : paintBatch(host as HTMLElement, { ...render, layers: fresh }, shown.painter, shown.session)
	const painted = batch === undefined ? [] : layerElements(batch.painted.root)
	const layers: ShownLayer[] = []
	let next = 0

	for (const entry of kept) {
		if (entry !== undefined) {
			layers.push(entry)

			continue
		}

		const element = painted[next]
		const layer = fresh[next++]

		// The painter drew another number of layers than it was given: the slide is painted whole instead.
		if (element === undefined || layer === undefined || batch === undefined) {
			if (batch !== undefined) releaseBatch(batch, 0)

			return false
		}

		layers.push({ element, batch, layer, transform: element.style.transform })
	}

	if (batch !== undefined) {
		// Its background is the shown one's: only its layers are taken.
		batch.live = painted.length
	}

	// What is no longer shown goes, its paints with their last layer.
	const left = new Set(layers.map(entry => entry.element))

	for (const entry of shown.layers) {
		if (left.has(entry.element)) continue

		entry.element.remove()
		releaseBatch(entry.batch)
	}

	// In render order where the layers start (after the background), each moved only where it is out of place.
	let at: Element | null = null

	for (const child of shown.root.children) {
		if (child instanceof HTMLElement && child.dataset["foLayer"] !== undefined) {
			at = child
			break
		}
	}

	layers.forEach((entry, index) => {
		const mark = String(index)

		if (entry.element.dataset["foLayer"] !== mark) entry.element.dataset["foLayer"] = mark
		if (entry.element === at) at = at.nextElementSibling
		else shown.root.insertBefore(entry.element, at)
	})

	if (shown.root instanceof HTMLElement && shown.root.dataset["foSlide"] !== String(render.index))
		shown.root.dataset["foSlide"] = String(render.index)

	shown.render = render
	shown.layers = layers

	return true
}

function fitScale(width: number, height: number, slideWidth: number, slideHeight: number): number {
	if (width <= 0 || height <= 0 || slideWidth <= 0 || slideHeight <= 0) return 0

	return Math.min(width / slideWidth, height / slideHeight)
}

export function SlideView({
	render,
	size,
	painter,
	session,
	label,
	zoom,
	mode: modeProp,
	actions,
	actionLabel,
	onScale,
	className,
	ref,
	overlay
}: SlideViewProps) {
	const mode = modeProp ?? "view"
	const slideWidth = size.cx / EMU_PER_PX
	const slideHeight = size.cy / EMU_PER_PX
	const frameRef = useRef<HTMLDivElement | null>(null)
	const hostRef = useRef<HTMLDivElement | null>(null)
	const [box, setBox] = useState({ width: 0, height: 0 })
	const scale = zoom ?? fitScale(box.width, box.height, slideWidth, slideHeight)

	useLayoutEffect(() => {
		const frame = frameRef.current

		if (frame === null || zoom !== undefined) return

		const read = (): void => {
			const width = frame.clientWidth
			const height = frame.clientHeight

			setBox(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
		}
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(read) : undefined

		read()
		observer?.observe(frame)

		return () => observer?.disconnect()
	}, [zoom])

	useLayoutEffect(() => {
		onScale?.(scale)
	}, [scale, onScale])

	const shownRef = useRef<Shown | undefined>(undefined)

	// A new render of the slide shown updates the painted slide in place: only the layers whose paint changed are
	// painted again (a moved layer takes its new matrix), so a nudge costs one layer, not the slide's whole DOM.
	useLayoutEffect(() => {
		const host = hostRef.current

		if (host === null) return

		const shown = shownRef.current

		if (render === undefined) {
			if (shown !== undefined) releaseShown(shown, host)

			shownRef.current = undefined

			return
		}

		if (shown !== undefined && shown.painter === painter && shown.session === session && updateShown(shown, render)) return
		if (shown !== undefined) releaseShown(shown, host)

		shownRef.current = paintShown(host, render, painter, session)
	}, [render, painter, session])

	useLayoutEffect(() => {
		const host = hostRef.current

		return () => {
			const shown = shownRef.current

			shownRef.current = undefined

			if (shown !== undefined && host !== null) releaseShown(shown, host)
		}
	}, [])

	const trigger = (layer: SlideLayer, event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): ActionTrigger => ({
		via: "click",
		mode,
		modifier: modifierOf(event),
		shape: layer.shape
	})

	// A text link inside a painted layer.
	const linkAt = (target: EventTarget | null) => {
		if (render === undefined || !(target instanceof Element)) return undefined

		const linkElement = target.closest<HTMLElement | SVGElement>("[data-fo-link]")
		const layerElement = linkElement?.closest<HTMLElement | SVGElement>("[data-fo-layer]")
		const layer = render.layers[Number(layerElement?.dataset["foLayer"] ?? Number.NaN)]
		const link = layer?.text?.links[Number(linkElement?.dataset["foLink"] ?? Number.NaN)]

		return layer === undefined || link === undefined ? undefined : { layer, link }
	}

	// What lies under a Mod+click in the editor, whose selection layer covers the slide: a text link, else a shape's
	// action hotspot (the topmost one).
	const underPoint = (
		event: MouseEvent<HTMLDivElement>
	):
		| { readonly kind: "link"; readonly found: NonNullable<ReturnType<typeof linkAt>> }
		| { readonly kind: "action"; readonly layer: SlideLayer }
		| undefined => {
		const elements = event.currentTarget.ownerDocument.elementsFromPoint?.(event.clientX, event.clientY) ?? []

		for (const element of elements) {
			const found = linkAt(element)

			if (found !== undefined) return { kind: "link", found }

			const hotspot = element.closest<HTMLElement>("[data-fo-hotspot]")
			const layer = render?.layers[Number(hotspot?.dataset["foHotspot"] ?? Number.NaN)]

			if (layer?.actions?.click !== undefined) return { kind: "action", layer }
		}

		return undefined
	}

	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		if (actions === undefined || event.button !== 0) return

		// A click that ends a selection is not a link activation.
		if ((globalThis.getSelection?.()?.isCollapsed ?? true) === false) return

		const found = linkAt(event.target)

		if (found !== undefined) {
			if (actions.link(found.link, trigger(found.layer, event)) !== "ignored") event.preventDefault()

			return
		}

		if (mode !== "edit" || !modifierOf(event)) return

		const under = underPoint(event)

		if (under?.kind === "link" && actions.link(under.found.link, trigger(under.found.layer, event)) !== "ignored")
			event.preventDefault()

		const click = under?.kind === "action" ? under.layer.actions?.click : undefined

		if (under?.kind === "action" && click !== undefined && actions.action(click, trigger(under.layer, event)) !== "ignored")
			event.preventDefault()
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (actions === undefined || event.key !== "Enter") return

		const found = linkAt(event.target)

		if (found === undefined) return

		if (actions.link(found.link, trigger(found.layer, event)) !== "ignored") event.preventDefault()
	}

	const hotspots: ReactNode[] = []

	if (render !== undefined && actions !== undefined) {
		render.layers.forEach((layer, index) => {
			const action = layer.actions?.click

			if (action === undefined) return

			hotspots.push(
				<button
					key={index}
					type="button"
					className="fo-slide-hotspot"
					data-fo-action={action.kind}
					data-fo-hotspot={index}
					aria-label={
						actionLabel?.(action, layer) ?? layer.alt ?? (action.kind === "url" ? action.href : layer.shape.id.toString())
					}
					style={hotspotStyle(layer)}
					onClick={event => {
						event.stopPropagation()

						if (actions.action(action, trigger(layer, event)) !== "ignored") event.preventDefault()
					}}
				/>
			)
		})
	}

	return (
		<div
			ref={element => {
				frameRef.current = element

				if (typeof ref === "function") return ref(element)

				if (ref !== undefined && ref !== null) ref.current = element

				return undefined
			}}
			className={className === undefined ? "fo-slide-view" : `fo-slide-view ${className}`}
			data-fo-slide-view=""
			data-fo-mode={mode}
		>
			<div
				className="fo-slide-frame"
				role="group"
				aria-label={label}
				data-fo-hidden={render?.hidden === true ? "" : undefined}
				data-fo-pending={render === undefined ? "" : undefined}
				style={{ width: slideWidth * scale, height: slideHeight * scale }}
				onClick={onClick}
				onKeyDown={onKeyDown}
			>
				<div
					className="fo-slide-paper"
					style={{
						width: slideWidth,
						height: slideHeight,
						transform: scale === 1 ? undefined : `scale(${String(scale)})`
					}}
				>
					<div
						ref={hostRef}
						className="fo-slide-content"
					/>
					{hotspots.length === 0 ? null : <div className="fo-slide-hotspots">{hotspots}</div>}
				</div>
				{overlay}
			</div>
		</div>
	)
}
