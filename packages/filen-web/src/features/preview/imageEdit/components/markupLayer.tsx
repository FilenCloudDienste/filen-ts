import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import type { MarkupColor, MarkupItem } from "@/features/preview/imageEdit/types"
import { inBox, strokeHit, textBox, type Box } from "@/features/preview/imageEdit/components/editorGeometry"
import {
	HIGHLIGHTER_ALPHA,
	strokeWidth,
	textSize,
	type MarkupMapping,
	type MarkupTool,
	type MarkupWidth
} from "@/features/preview/imageEdit/components/markupStyle"

// How close (screen px) a pointer must come to a drawing for the eraser to take it.
const ERASER_SLACK = 8
// Screen px a pointer must travel before a stroke takes another point.
const MIN_STEP = 1.5

interface TextDraft {
	id: string
	at: readonly [number, number]
	color: MarkupColor
	size: number
	text: string
}

interface Stroke {
	tool: "pen" | "highlighter" | "arrow"
	// Screen px, for the live line.
	screen: number[]
	// Source px, committed.
	source: number[]
	width: number
	context: CanvasRenderingContext2D | null
}

function drawArrowHead(context: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number, width: number): void {
	const angle = Math.atan2(toY - fromY, toX - fromX)
	const length = Math.max(width * 4, 10)

	context.beginPath()
	context.moveTo(toX - length * Math.cos(angle - Math.PI / 6), toY - length * Math.sin(angle - Math.PI / 6))
	context.lineTo(toX, toY)
	context.lineTo(toX - length * Math.cos(angle + Math.PI / 6), toY - length * Math.sin(angle + Math.PI / 6))
	context.stroke()
}

function newId(): string {
	return crypto.randomUUID()
}

// The drawing surface over the picture while the Markup tab is open. A stroke is drawn live on this layer's own
// canvas and committed once, on release, in source pixels; the render worker draws every committed item. The text
// item being edited is an input in place (the editor leaves it out of the rendered picture meanwhile).
export function MarkupLayer(props: {
	frame: Box
	mapping: MarkupMapping
	longerSide: number
	markup: readonly MarkupItem[]
	tool: MarkupTool
	color: MarkupColor
	width: MarkupWidth
	onCommit: (markup: readonly MarkupItem[], coalesceKey: string | undefined) => void
	onEditingChange: (id: string | null) => void
}) {
	const { t } = useTranslation("preview")
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	const stroke = useRef<Stroke | null>(null)
	const [draft, setDraft] = useState<TextDraft | null>(null)

	const local = (event: ReactPointerEvent<HTMLElement>, box: DOMRect): readonly [number, number] => [
		event.clientX - box.left,
		event.clientY - box.top
	]
	// The pointer's box, read once per gesture.
	const boxRef = useRef<DOMRect | null>(null)

	// The item whose edit is open: a blur after Enter or a click beside the field must not end it twice.
	const editingRef = useRef<string | null>(null)

	const startEditing = (next: TextDraft): void => {
		editingRef.current = next.id
		setDraft(next)
		props.onEditingChange(next.id)
	}

	const finishEditing = (keep: boolean): void => {
		if (draft === null) {
			return
		}

		if (editingRef.current !== draft.id) {
			return
		}

		editingRef.current = null
		setDraft(null)
		props.onEditingChange(null)

		if (!keep) {
			return
		}

		const text = draft.text.trim()
		const existing = props.markup.some(item => item.id === draft.id)

		if (text.length === 0) {
			if (existing) {
				props.onCommit(
					props.markup.filter(item => item.id !== draft.id),
					undefined
				)
			}

			return
		}

		const item: MarkupItem = { kind: "text", id: draft.id, color: draft.color, size: draft.size, at: draft.at, text }

		props.onCommit(existing ? props.markup.map(other => (other.id === draft.id ? item : other)) : [...props.markup, item], undefined)
	}

	const textAt = (x: number, y: number): Extract<MarkupItem, { kind: "text" }> | null => {
		for (let index = props.markup.length - 1; index >= 0; index--) {
			const item = props.markup[index]

			if (item?.kind === "text") {
				const anchor = props.mapping.toScreen(item.at[0], item.at[1])

				if (inBox(textBox(anchor, item.text, item.size * props.mapping.scale), x, y, ERASER_SLACK)) {
					return item
				}
			}
		}

		return null
	}

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0 || event.target !== event.currentTarget) {
			return
		}

		const box = event.currentTarget.getBoundingClientRect()
		const [x, y] = local(event, box)

		if (draft !== null) {
			// A click beside the field ends the edit; the next one draws.
			finishEditing(true)

			return
		}

		if (props.tool === "eraser") {
			const [sx, sy] = props.mapping.toSource(x, y)
			const hit = textAt(x, y) ?? strokeHit(props.markup, sx, sy, ERASER_SLACK / props.mapping.scale)

			if (hit !== null) {
				props.onCommit(
					props.markup.filter(item => item.id !== hit.id),
					undefined
				)
			}

			return
		}

		if (props.tool === "text") {
			event.preventDefault()

			const hit = textAt(x, y)

			startEditing(
				hit === null
					? {
							id: newId(),
							at: props.mapping.toSource(x, y),
							color: props.color,
							size: textSize(props.width, props.longerSide),
							text: ""
						}
					: { id: hit.id, at: hit.at, color: hit.color, size: hit.size, text: hit.text }
			)

			return
		}

		event.currentTarget.setPointerCapture(event.pointerId)
		boxRef.current = box

		const canvas = canvasRef.current
		const ratio = window.devicePixelRatio
		const width = strokeWidth(props.width, props.tool, props.longerSide)
		let context: CanvasRenderingContext2D | null = null

		if (canvas !== null) {
			canvas.width = Math.round(box.width * ratio)
			canvas.height = Math.round(box.height * ratio)
			context = canvas.getContext("2d")

			if (context !== null) {
				context.setTransform(ratio, 0, 0, ratio, 0, 0)
				context.lineCap = "round"
				context.lineJoin = "round"
				context.strokeStyle = props.color
				context.lineWidth = Math.max(1, width * props.mapping.scale)
				canvas.style.opacity = props.tool === "highlighter" ? String(HIGHLIGHTER_ALPHA) : "1"
			}
		}

		const [sx, sy] = props.mapping.toSource(x, y)

		stroke.current = { tool: props.tool, screen: [x, y], source: [sx, sy], width, context }
	}

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		const current = stroke.current
		const box = boxRef.current

		if (current === null || box === null) {
			return
		}

		const [x, y] = local(event, box)
		const length = current.screen.length
		const lastX = current.screen[length - 2] ?? x
		const lastY = current.screen[length - 1] ?? y
		const context = current.context

		if (current.tool === "arrow") {
			current.screen.length = 2
			current.screen.push(x, y)

			if (context !== null) {
				const fromX = current.screen[0] ?? x
				const fromY = current.screen[1] ?? y

				context.clearRect(0, 0, box.width, box.height)
				context.beginPath()
				context.moveTo(fromX, fromY)
				context.lineTo(x, y)
				context.stroke()
				drawArrowHead(context, fromX, fromY, x, y, context.lineWidth)
			}

			return
		}

		if (Math.hypot(x - lastX, y - lastY) < MIN_STEP) {
			return
		}

		current.screen.push(x, y)

		const [sx, sy] = props.mapping.toSource(x, y)

		current.source.push(sx, sy)

		if (context !== null) {
			// The highlighter's whole stroke is redrawn so its overlaps stay one flat tone.
			if (current.tool === "highlighter") {
				context.clearRect(0, 0, box.width, box.height)
				context.beginPath()
				context.moveTo(current.screen[0] ?? x, current.screen[1] ?? y)

				for (let at = 2; at + 1 < current.screen.length; at += 2) {
					context.lineTo(current.screen[at] ?? x, current.screen[at + 1] ?? y)
				}

				context.stroke()
			} else {
				context.beginPath()
				context.moveTo(lastX, lastY)
				context.lineTo(x, y)
				context.stroke()
			}
		}
	}

	const endStroke = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean): void => {
		const current = stroke.current
		const box = boxRef.current

		stroke.current = null
		boxRef.current = null

		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		if (current === null) {
			return
		}

		current.context?.clearRect(0, 0, box?.width ?? 0, box?.height ?? 0)

		if (!keep) {
			return
		}

		if (current.tool === "arrow") {
			const [fromX, fromY, toX, toY] = current.screen

			if (
				fromX === undefined ||
				fromY === undefined ||
				toX === undefined ||
				toY === undefined ||
				Math.hypot(toX - fromX, toY - fromY) < MIN_STEP * 4
			) {
				return
			}

			props.onCommit(
				[
					...props.markup,
					{
						kind: "arrow",
						id: newId(),
						color: props.color,
						width: current.width,
						from: props.mapping.toSource(fromX, fromY),
						to: props.mapping.toSource(toX, toY)
					}
				],
				undefined
			)

			return
		}

		// A tap draws a dot.
		const points = current.source.length === 2 ? [...current.source, ...current.source] : current.source

		props.onCommit([...props.markup, { kind: current.tool, id: newId(), color: props.color, width: current.width, points }], undefined)
	}

	const editingAnchor = draft === null ? null : props.mapping.toScreen(draft.at[0], draft.at[1])
	const editingFontSize = draft === null ? 0 : draft.size * props.mapping.scale

	return (
		<div
			role="application"
			aria-label={t("previewImageEditMarkupSurface")}
			className="absolute cursor-crosshair touch-none select-none data-[tool=eraser]:cursor-cell data-[tool=text]:cursor-text"
			data-tool={props.tool}
			style={{ left: props.frame.left, top: props.frame.top, width: props.frame.width, height: props.frame.height }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={event => {
				endStroke(event, true)
			}}
			onPointerCancel={event => {
				endStroke(event, false)
			}}
		>
			<canvas
				ref={canvasRef}
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 size-full"
			/>
			{draft !== null && editingAnchor !== null ? (
				<input
					// Placed on a fresh text item, focused right away.
					autoFocus
					type="text"
					aria-label={t("previewImageEditTextField")}
					value={draft.text}
					className="absolute min-w-8 border-0 bg-transparent p-0 leading-[1.2] font-semibold outline-1 outline-offset-2 outline-white/70 outline-dashed"
					style={{
						left: editingAnchor[0],
						top: editingAnchor[1],
						fontSize: editingFontSize,
						color: draft.color,
						width: `${String(Math.max(1, draft.text.length + 1) * 0.6)}em`
					}}
					onChange={event => {
						setDraft({ ...draft, text: event.target.value })
					}}
					onBlur={() => {
						finishEditing(true)
					}}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault()
							finishEditing(true)
						} else if (event.key === "Escape") {
							// Taken here: the preview overlay leaves edit mode on an Escape nothing inside took.
							event.preventDefault()
							event.stopPropagation()
							finishEditing(false)
						}
					}}
				/>
			) : null}
		</div>
	)
}
