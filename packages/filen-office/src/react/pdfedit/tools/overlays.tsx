import { useLayoutEffect, useRef, type CSSProperties } from "react"
import type { PdfPoint, PdfQuad, PdfRect, PdfRgb, PdfTextAlign } from "../../../core/pdfedit/annotations"
import { inkDraftPoints, type InkStroke } from "./ink"
import { SELECT_HANDLES } from "./select"

// What the tools draw over a page while they work, positioned in page space: each overlay fills its page element
// (position: relative) and places itself by percentages of the page box, so it follows every zoom without a scale.
// Structure only (css/pdfedit.css); colours are --fo-pdf-* variables.

export type PdfToolDraft =
	| { readonly kind: "rect"; readonly rect: PdfRect }
	| { readonly kind: "ellipse"; readonly rect: PdfRect }
	| { readonly kind: "line"; readonly from: PdfPoint; readonly to: PdfPoint }
	| { readonly kind: "ink"; readonly stroke: InkStroke; readonly color?: PdfRgb; readonly width?: number }
	| { readonly kind: "quads"; readonly quads: readonly PdfQuad[] }

function percent(value: number, size: number): string {
	return `${String(size === 0 ? 0 : (value / size) * 100)}%`
}

// A rect of page space as the CSS box of an element filling the page.
export function rectStyle(rect: PdfRect, box: PdfRect): CSSProperties {
	const width = box[2] - box[0]
	const height = box[3] - box[1]

	return {
		left: percent(rect[0] - box[0], width),
		top: percent(rect[1] - box[1], height),
		width: percent(rect[2] - rect[0], width),
		height: percent(rect[3] - rect[1], height)
	}
}

function rgbCss(rgb: PdfRgb): string {
	return `rgb(${rgb.map(component => String(Math.round(component * 255))).join(" ")})`
}

function quadPoints(quad: PdfQuad): string {
	// Upper-left, upper-right, lower-right, lower-left.
	return `${String(quad[0])},${String(quad[1])} ${String(quad[2])},${String(quad[3])} ${String(quad[6])},${String(quad[7])} ${String(quad[4])},${String(quad[5])}`
}

// The stroke being drawn, kept up by appending each new point to the polyline's point list: a move costs one point,
// never a rebuild of the whole points attribute (which made a long stroke quadratic). Where the list can't be
// appended to, the attribute is written whole.
function InkDraft({ stroke, style }: { stroke: InkStroke; style: CSSProperties }) {
	const lineRef = useRef<SVGPolylineElement | null>(null)
	// The stroke's values (x, y pairs) already in the list, and where that stroke started (a new stroke starts anew).
	const drawn = useRef(0)
	const start = useRef<{ readonly page: number; readonly x: number; readonly y: number } | null>(null)

	useLayoutEffect(() => {
		const line = lineRef.current
		const svg = line?.ownerSVGElement ?? null
		const list: SVGPointList | undefined = line?.points

		if (line === null || svg === null || list === undefined) {
			line?.setAttribute("points", inkDraftPoints(stroke))

			return
		}

		const x = stroke.points[0] ?? 0
		const y = stroke.points[1] ?? 0
		const begun = start.current

		if (stroke.length < drawn.current || begun === null || begun.page !== stroke.page || begun.x !== x || begun.y !== y) {
			list.clear()
			drawn.current = 0
			start.current = { page: stroke.page, x, y }
		}

		for (let index = drawn.current; index + 1 < stroke.length; index += 2) {
			const point = svg.createSVGPoint()

			point.x = stroke.points[index] ?? 0
			point.y = stroke.points[index + 1] ?? 0
			list.appendItem(point)
		}

		drawn.current = stroke.length
	}, [stroke])

	return (
		<polyline
			ref={lineRef}
			className="fo-pdf-tool-ink"
			style={style}
		/>
	)
}

// The shape a tool is drawing (not yet a document change).
export function PdfToolDraftOverlay({ draft, box }: { draft: PdfToolDraft; box: PdfRect }) {
	return (
		<svg
			className="fo-pdf-tool-overlay"
			viewBox={`${String(box[0])} ${String(box[1])} ${String(box[2] - box[0])} ${String(box[3] - box[1])}`}
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			{draft.kind === "rect" ? (
				<rect
					className="fo-pdf-tool-draft"
					x={draft.rect[0]}
					y={draft.rect[1]}
					width={draft.rect[2] - draft.rect[0]}
					height={draft.rect[3] - draft.rect[1]}
				/>
			) : draft.kind === "ellipse" ? (
				<ellipse
					className="fo-pdf-tool-draft"
					cx={(draft.rect[0] + draft.rect[2]) / 2}
					cy={(draft.rect[1] + draft.rect[3]) / 2}
					rx={(draft.rect[2] - draft.rect[0]) / 2}
					ry={(draft.rect[3] - draft.rect[1]) / 2}
				/>
			) : draft.kind === "line" ? (
				<line
					className="fo-pdf-tool-draft"
					x1={draft.from[0]}
					y1={draft.from[1]}
					x2={draft.to[0]}
					y2={draft.to[1]}
				/>
			) : draft.kind === "ink" ? (
				<InkDraft
					stroke={draft.stroke}
					style={{
						...(draft.color === undefined ? {} : { stroke: rgbCss(draft.color) }),
						...(draft.width === undefined ? {} : { strokeWidth: draft.width })
					}}
				/>
			) : (
				draft.quads.map((quad, index) => (
					<polygon
						// Quads of one drag never reorder.
						key={index}
						className="fo-pdf-tool-quad"
						points={quadPoints(quad)}
					/>
				))
			)}
		</svg>
	)
}

// The selected annotation's frame, with resize handles when it can be resized.
export function PdfSelectionFrame({ rect, box, handles }: { rect: PdfRect; box: PdfRect; handles: boolean }) {
	return (
		<div
			className="fo-pdf-tool-selection"
			style={rectStyle(rect, box)}
			aria-hidden="true"
		>
			{handles
				? SELECT_HANDLES.map(handle => (
						<span
							key={handle}
							className="fo-pdf-tool-handle"
							data-handle={handle}
						/>
					))
				: null}
		</div>
	)
}

// A keyboard placement's rect. The host says its position in its own live region, one that stays mounted (a region
// mounted with its text is often not read).
export function PdfPlacementIndicator({ rect, box }: { rect: PdfRect; box: PdfRect }) {
	return (
		<div
			className="fo-pdf-tool-placement"
			style={rectStyle(rect, box)}
			aria-hidden="true"
		/>
	)
}

const ALIGN: Readonly<Record<PdfTextAlign, CSSProperties["textAlign"]>> = { left: "left", center: "center", right: "right" }

// The text box editor standing in for a box being typed into (the engine hides that annotation meanwhile). `scale`:
// CSS pixels per point at the current zoom, for the font size.
export function PdfTextBoxEditor({
	rect,
	box,
	text,
	size,
	scale,
	color,
	align,
	label,
	onInput,
	onDone
}: {
	rect: PdfRect
	box: PdfRect
	text: string
	size: number
	scale: number
	color: PdfRgb
	align: PdfTextAlign
	label: string
	onInput: (text: string) => void
	onDone: () => void
}) {
	return (
		<textarea
			className="fo-pdf-tool-text-editor"
			aria-label={label}
			// The box is placed by the user's own gesture; typing starts at once.
			autoFocus
			spellCheck
			value={text}
			style={{ ...rectStyle(rect, box), fontSize: `${String(size * scale)}px`, color: rgbCss(color), textAlign: ALIGN[align] }}
			onChange={event => {
				onInput(event.currentTarget.value)
			}}
			onBlur={onDone}
			onKeyDown={event => {
				// Mod+Enter finishes (Enter is a new line); Escape is the tool's (it drops a new box).
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
					event.preventDefault()
					onDone()
				}
			}}
		/>
	)
}
