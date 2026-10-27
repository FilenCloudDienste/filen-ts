import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type PointerEvent } from "react"
import type { SlideRef } from "../../../core/presentation/model"
import type { InkChange, InkStore, InkStrokeBuffer, InkTool } from "./store"

// The ink over one slide: drawn on two canvases (highlighter strokes under a translucent one so a stroke never
// darkens where it overlaps itself, pen strokes above) and a laser dot moved by a transform. It sits inside the
// slide's frame (SlideView's overlay) and maps pointer positions to slide EMU through the frame's box, taken once
// per stroke. A stroke is drawn as it grows, one segment per pointer event and nothing more, so every window
// listening to the store draws it in the same task.

export interface InkLayerProps {
	readonly store: InkStore
	readonly slide: SlideRef | undefined
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	// Takes the pointer for the active tool (the presenter's next-slide preview does not).
	readonly interactive?: boolean
	// The laser pointer's accessible name is not needed (it is decoration); the canvas's is.
	readonly label?: string
}

// The highlighter canvas's opacity.
const HIGHLIGHT_OPACITY = 0.45
// Eraser reach in screen px.
const ERASER_PX = 8
const LASER_PX = 14

const CURSORS: Readonly<Record<InkTool, string | undefined>> = {
	none: undefined,
	pen: "crosshair",
	highlighter: "crosshair",
	eraser: "cell",
	laser: "none"
}

function canvasContext(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
	return canvas?.getContext("2d") ?? null
}

// Strokes in EMU under the canvas transform: line width and points need no per-point scaling.
function strokePath(context: CanvasRenderingContext2D, stroke: InkStrokeBuffer, from: number): void {
	const points = stroke.points
	const start = Math.max(0, from - 2)

	context.strokeStyle = `#${stroke.color}`
	context.lineWidth = stroke.width
	context.beginPath()
	context.moveTo(points[start] ?? 0, points[start + 1] ?? 0)

	// A lone point is a dot: a zero-length line with round caps.
	if (stroke.length - start <= 2) context.lineTo(points[start] ?? 0, points[start + 1] ?? 0)

	for (let index = start + 2; index < stroke.length; index += 2) context.lineTo(points[index] ?? 0, points[index + 1] ?? 0)

	context.stroke()
}

export function InkLayer({ store, slide, size, interactive = true, label }: InkLayerProps) {
	const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const penRef = useRef<HTMLCanvasElement | null>(null)
	const highlightRef = useRef<HTMLCanvasElement | null>(null)
	const laserRef = useRef<HTMLDivElement | null>(null)
	// The frame's box while a pointer is down (one layout read per stroke).
	const box = useRef<{ left: number; top: number; scaleX: number; scaleY: number } | undefined>(undefined)
	const drawing = useRef<number | undefined>(undefined)
	// The layer's size in device px, from the last redraw.
	const pixels = useRef({ width: 1, height: 1 })

	// A canvas holds full-size pixels only while its slide has strokes of its kind (1 x 1 otherwise).
	const prepare = (canvas: HTMLCanvasElement | null, needed: boolean): void => {
		const context = canvasContext(canvas)

		if (canvas === null || context === null) return

		const pixelWidth = needed ? pixels.current.width : 1
		const pixelHeight = needed ? pixels.current.height : 1

		if (canvas.width !== pixelWidth) canvas.width = pixelWidth
		if (canvas.height !== pixelHeight) canvas.height = pixelHeight

		context.setTransform(pixelWidth / size.cx, 0, 0, pixelHeight / size.cy, 0, 0)
		context.lineCap = "round"
		context.lineJoin = "round"
		context.clearRect(0, 0, size.cx, size.cy)
	}

	const redraw = (): void => {
		const root = rootRef.current

		if (root === null) return

		// Canvas pixels at the size the layer shows at (inside a scaled stage box that is not its layout size).
		const ratio = root.ownerDocument.defaultView?.devicePixelRatio ?? 1
		const rect = root.getBoundingClientRect()
		const strokes = slide === undefined ? [] : store.strokes(slide)

		pixels.current = { width: Math.max(1, Math.round(rect.width * ratio)), height: Math.max(1, Math.round(rect.height * ratio)) }
		prepare(
			penRef.current,
			strokes.some(stroke => !stroke.highlighter)
		)
		prepare(
			highlightRef.current,
			strokes.some(stroke => stroke.highlighter)
		)

		const pen = canvasContext(penRef.current)
		const highlight = canvasContext(highlightRef.current)

		for (const stroke of strokes) {
			const context = stroke.highlighter ? highlight : pen

			if (context !== null) strokePath(context, stroke, 0)
		}
	}

	// Sized to the frame and drawn again when it resizes or the slide changes.
	useLayoutEffect(() => {
		const root = rootRef.current

		if (root === null) return

		redraw()

		const View = root.ownerDocument.defaultView as (Window & typeof globalThis) | null
		const observer = View !== null && typeof View.ResizeObserver === "function" ? new View.ResizeObserver(redraw) : undefined

		observer?.observe(root)

		// The stage scales its slide box with a transform, which a resize of the box itself never reports.
		const stage = root.closest("[data-fo-show-stage]")

		if (stage !== null) observer?.observe(stage)

		return () => observer?.disconnect()
	}, [store, slide, size.cx, size.cy])

	useEffect(
		() =>
			store.listen((change: InkChange) => {
				if (change.slide !== slide) return

				switch (change.kind) {
					case "extend": {
						const canvas = change.stroke.highlighter ? highlightRef.current : penRef.current
						const context = canvasContext(canvas)

						if (canvas === null || context === null) return

						// The slide's first stroke of its kind: the canvas takes its full size (and every stroke, this one too).
						if (canvas.width !== pixels.current.width || canvas.height !== pixels.current.height) {
							redraw()

							return
						}

						strokePath(context, change.stroke, change.from)

						return
					}
					case "redraw":
						redraw()
						return
					case "laser": {
						const laser = laserRef.current
						const root = rootRef.current

						if (laser === null || root === null) return

						laser.style.visibility = change.visible ? "visible" : "hidden"

						if (change.visible) {
							const x = (change.x / size.cx) * root.clientWidth - LASER_PX / 2
							const y = (change.y / size.cy) * root.clientHeight - LASER_PX / 2

							laser.style.transform = `translate(${String(x)}px,${String(y)}px)`
						}
					}
				}
			}),
		[store, size.cx, size.cy, slide]
	)

	// Leaving the laser hides the dot.
	useEffect(() => {
		if (state.tool !== "laser" && slide !== undefined) store.laser(slide, 0, 0, false)
	}, [state.tool, slide, store])

	const active = interactive && state.tool !== "none" && slide !== undefined

	const measure = (element: HTMLDivElement): void => {
		const rect = element.getBoundingClientRect()

		box.current = {
			left: rect.left,
			top: rect.top,
			scaleX: rect.width > 0 ? size.cx / rect.width : 0,
			scaleY: rect.height > 0 ? size.cy / rect.height : 0
		}
	}

	const toSlide = (event: { readonly clientX: number; readonly clientY: number }): [number, number] => {
		const at = box.current

		return at === undefined ? [0, 0] : [(event.clientX - at.left) * at.scaleX, (event.clientY - at.top) * at.scaleY]
	}

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (!active || slide === undefined || (event.pointerType === "mouse" && event.button !== 0)) return

		event.preventDefault()
		event.stopPropagation()
		measure(event.currentTarget)
		event.currentTarget.setPointerCapture(event.pointerId)
		drawing.current = event.pointerId

		const [x, y] = toSlide(event)

		switch (state.tool) {
			case "pen":
			case "highlighter":
				store.begin(slide, x, y)
				return
			case "eraser":
				store.eraseAt(slide, x, y, ERASER_PX * (box.current?.scaleX ?? 0))
				return
			case "laser":
				store.laser(slide, x, y, true)
		}
	}

	const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
		if (!active || slide === undefined) return

		const down = drawing.current === event.pointerId

		// The laser follows a hovering mouse or pen; a finger shows it only while down.
		if (state.tool === "laser" && (down || event.pointerType !== "touch")) {
			if (!down) measure(event.currentTarget)

			const [x, y] = toSlide(event)

			store.laser(slide, x, y, true)

			return
		}

		if (!down) return

		if (state.tool === "eraser") {
			const [x, y] = toSlide(event)

			store.eraseAt(slide, x, y, ERASER_PX * (box.current?.scaleX ?? 0))

			return
		}

		// Every sample since the last event (pens report several per frame).
		const native = event.nativeEvent
		const samples = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : []
		const xy: number[] = []

		for (const sample of samples.length === 0 ? [native] : samples) {
			const [x, y] = toSlide(sample)

			xy.push(x, y)
		}

		store.extend(xy)
	}

	const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
		if (drawing.current !== event.pointerId) return

		drawing.current = undefined
		store.end()

		if (state.tool === "laser" && event.pointerType === "touch" && slide !== undefined) store.laser(slide, 0, 0, false)
	}

	return (
		<div
			ref={rootRef}
			className="fo-ink-layer"
			data-fo-ink-tool={state.tool}
			role={active ? "img" : undefined}
			aria-label={active ? label : undefined}
			aria-hidden={active ? undefined : true}
			style={{
				position: "absolute",
				inset: 0,
				overflow: "hidden",
				pointerEvents: active ? "auto" : "none",
				touchAction: active ? "none" : undefined,
				cursor: active ? CURSORS[state.tool] : undefined
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onPointerLeave={event => {
				if (state.tool === "laser" && drawing.current === undefined && slide !== undefined && event.pointerType !== "touch")
					store.laser(slide, 0, 0, false)
			}}
			// Drawing never advances the show (the stage takes clicks to go on).
			onClick={event => {
				if (active) event.stopPropagation()
			}}
		>
			<canvas
				ref={highlightRef}
				style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: HIGHLIGHT_OPACITY }}
			/>
			<canvas
				ref={penRef}
				style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
			/>
			<div
				ref={laserRef}
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: LASER_PX,
					height: LASER_PX,
					borderRadius: "50%",
					background: "radial-gradient(circle, #fff 0, #ff2020 35%, rgba(255,0,0,0.6) 60%, rgba(255,0,0,0) 72%)",
					boxShadow: "0 0 10px 3px rgba(255,0,0,0.55)",
					visibility: "hidden",
					pointerEvents: "none",
					willChange: "transform"
				}}
			/>
		</div>
	)
}
