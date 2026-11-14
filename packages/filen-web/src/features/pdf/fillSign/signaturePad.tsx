import { useEffect, useRef } from "react"
import { smoothStroke } from "@filen/office/core/pdfedit/visualSignature"
import { drawStrokes, SIGNATURE_INK } from "@/features/pdf/fillSign/signatureRender"

// The drawing area of the signature dialog: pointer events (mouse, pen, touch alike; pressure ignored), one stroke per
// press. The stroke in progress is drawn straight onto the canvas as its points arrive (no React render per move);
// on release it is smoothed on this thread and handed to `onStroke`, and the finished strokes (`strokes`, CSS px) are
// redrawn. A second finger while drawing is ignored.

export const SIGNATURE_LINE_PX = 2.5

export interface SignaturePadProps {
	strokes: readonly (readonly number[])[]
	onStroke: (stroke: number[]) => void
	label: string
	hint: string
}

interface LiveStroke {
	readonly pointerId: number
	readonly left: number
	readonly top: number
	readonly points: number[]
}

function redraw(canvas: HTMLCanvasElement, strokes: readonly (readonly number[])[]): void {
	const ratio = window.devicePixelRatio || 1
	const width = Math.round(canvas.clientWidth * ratio)
	const height = Math.round(canvas.clientHeight * ratio)

	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width
		canvas.height = height
	}

	const context = canvas.getContext("2d")

	if (context === null) return

	context.setTransform(1, 0, 0, 1, 0, 0)
	context.clearRect(0, 0, width, height)
	context.setTransform(ratio, 0, 0, ratio, 0, 0)
	drawStrokes(context, strokes, SIGNATURE_LINE_PX)
}

function extend(canvas: HTMLCanvasElement, live: LiveStroke, x: number, y: number): void {
	const points = live.points
	const lastX = points[points.length - 2] ?? x
	const lastY = points[points.length - 1] ?? y

	points.push(x, y)

	const context = canvas.getContext("2d")

	if (context === null) return

	context.lineCap = "round"
	context.lineJoin = "round"
	context.lineWidth = SIGNATURE_LINE_PX
	context.strokeStyle = SIGNATURE_INK
	context.beginPath()
	context.moveTo(lastX, lastY)
	context.lineTo(x === lastX && y === lastY ? x + 0.01 : x, y)
	context.stroke()
}

// Keeps the pointer's moves on the canvas when it leaves it. A pointer that already ended (or a synthetic one) cannot be
// captured: drawing goes on without.
function capture(canvas: HTMLCanvasElement, pointerId: number): void {
	try {
		canvas.setPointerCapture(pointerId)
	} catch {
		// NotFoundError: no active pointer with this id.
	}
}

export function SignaturePad({ strokes, onStroke, label, hint }: SignaturePadProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const liveRef = useRef<LiveStroke | null>(null)
	const strokesRef = useRef(strokes)

	useEffect(() => {
		strokesRef.current = strokes

		const canvas = canvasRef.current

		if (canvas !== null) redraw(canvas, strokes)
	}, [strokes])

	useEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null) return

		const observer = new ResizeObserver(() => {
			redraw(canvas, strokesRef.current)
		})

		observer.observe(canvas)

		return () => {
			observer.disconnect()
		}
	}, [])

	function finish(pointerId: number): void {
		const live = liveRef.current

		if (live?.pointerId !== pointerId) return

		liveRef.current = null
		onStroke(smoothStroke(live.points))
	}

	return (
		<div className="relative h-44 w-full overflow-hidden rounded-xl border border-input bg-white">
			{strokes.length === 0 ? (
				<span
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-6 mx-6 border-b border-dashed border-neutral-300 pb-1 text-xs text-neutral-400 select-none"
				>
					{hint}
				</span>
			) : null}
			<canvas
				ref={canvasRef}
				role="img"
				aria-label={label}
				data-strokes={strokes.length}
				className="absolute inset-0 size-full cursor-crosshair touch-none"
				onPointerDown={event => {
					if (liveRef.current !== null || (event.pointerType === "mouse" && event.button !== 0)) return

					const canvas = event.currentTarget
					const rect = canvas.getBoundingClientRect()

					event.preventDefault()
					capture(canvas, event.pointerId)
					liveRef.current = { pointerId: event.pointerId, left: rect.left, top: rect.top, points: [] }
					extend(canvas, liveRef.current, event.clientX - rect.left, event.clientY - rect.top)
				}}
				onPointerMove={event => {
					const live = liveRef.current

					if (live?.pointerId !== event.pointerId) return

					// Every sample the pointer produced since the last frame, so fast strokes keep their shape.
					const samples = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : []

					for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
						extend(event.currentTarget, live, sample.clientX - live.left, sample.clientY - live.top)
					}
				}}
				onPointerUp={event => {
					finish(event.pointerId)
				}}
				onPointerCancel={event => {
					finish(event.pointerId)
				}}
			/>
		</div>
	)
}
