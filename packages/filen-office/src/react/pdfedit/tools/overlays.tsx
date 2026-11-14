import type { CSSProperties } from "react"
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
				<polyline
					className="fo-pdf-tool-ink"
					points={inkDraftPoints(draft.stroke)}
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

// A keyboard placement's rect, and its position said in a polite live region (`announcement`, from the host's
// strings).
export function PdfPlacementIndicator({ rect, box, announcement }: { rect: PdfRect; box: PdfRect; announcement: string }) {
	return (
		<>
			<div
				className="fo-pdf-tool-placement"
				style={rectStyle(rect, box)}
				aria-hidden="true"
			/>
			<span
				className="fo-pdf-sr-only"
				role="status"
				aria-live="polite"
			>
				{announcement}
			</span>
		</>
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
