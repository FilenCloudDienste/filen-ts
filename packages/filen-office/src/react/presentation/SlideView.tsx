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

	useLayoutEffect(() => {
		const host = hostRef.current

		if (host === null || render === undefined) return

		const signal = { aborted: false }
		const painted = painter(render, { document: host.ownerDocument, session, signal })

		host.replaceChildren(painted.root)

		return () => {
			signal.aborted = true
			painted.release()
			host.replaceChildren()
		}
	}, [render, painter, session])

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
