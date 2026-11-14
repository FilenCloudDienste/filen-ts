import { useEffect, useEffectEvent, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import type { PdfQuad } from "@filen/office/core/pdfedit/annotations"
import type { PdfTextGeometryLine } from "@filen/office/dom/pdfedit"
import {
	markupPointer,
	markupTool,
	quadsFromLines,
	RECT_TOOL_IDLE,
	rectToolDraft,
	rectToolKey,
	rectToolPointer,
	type MarkupState,
	type RectToolState,
	type ToolKeyName,
	type ToolPointer
} from "@filen/office/react/pdfedit/tools"
import { placementPosition } from "@filen/office/react/pdfedit"
import { useToolSession } from "@/features/pdf/session/useToolSession"
import type { PdfToolOverlayProps } from "@/features/pdf/tools/registry"
import { pageSpaceBox, toBoxStyle, toPageSpace, type PageRect } from "@/features/pdf/redact/redactOverlay.logic"

// What the Area and Text redaction tools draw over a page while they are active. Area: drag a rectangle (or, with the
// page focused, Enter places one at its centre, the arrows move it (Shift ×10), Alt with the arrows resizes it, Enter
// marks it, Escape cancels). Text: drag over the page's text; the characters between the two points are marked. A
// mark is a Redact annotation the page then shows; nothing is removed until the marks are applied.

// An area mark's size when placed by a click or from the keyboard, in points.
const AREA_SIZE = { width: 160, height: 40 }

const KEYS: ReadonlySet<string> = new Set(["Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])

function isToolKey(key: string): key is ToolKeyName {
	return KEYS.has(key)
}

const DRAFT = "pointer-events-none absolute border-2 border-destructive bg-destructive/20"

function pointer(event: PointerEvent<HTMLDivElement>, type: ToolPointer["type"], props: PdfToolOverlayProps): ToolPointer {
	const box = event.currentTarget.getBoundingClientRect()

	return {
		type,
		page: props.page,
		box: pageSpaceBox(props.viewport),
		point: toPageSpace(props.viewport, event.clientX - box.left, event.clientY - box.top),
		shift: event.shiftKey
	}
}

function Draft({ props, rect }: { props: PdfToolOverlayProps; rect: PageRect }) {
	return (
		<div
			className={DRAFT}
			style={toBoxStyle(props.viewport, rect)}
		/>
	)
}

export function RedactAreaOverlay(props: PdfToolOverlayProps) {
	const { t } = useTranslation("preview")
	const [state, setState] = useState<RectToolState>(RECT_TOOL_IDLE)
	const draft = rectToolDraft(state)
	const box = pageSpaceBox(props.viewport)

	const mark = (rect: PageRect): void => {
		props.context.edit(session => session.dispatch("redact.markArea", { page: props.page, rect }))
	}

	const step = (event: PointerEvent<HTMLDivElement>, type: ToolPointer["type"]): void => {
		const next = rectToolPointer(state, pointer(event, type, props), AREA_SIZE)

		setState(next.state)

		if (next.commit !== undefined) mark(next.commit.rect)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.target !== event.currentTarget || !isToolKey(event.key) || event.nativeEvent.isComposing) return
		if (state.placement === null && event.key !== "Enter") return

		event.preventDefault()
		event.stopPropagation()

		const next = rectToolKey(state, { key: event.key, shift: event.shiftKey, alt: event.altKey }, { page: props.page, box }, AREA_SIZE)

		setState(next.state)

		if (next.commit !== undefined) mark(next.commit.rect)
	}

	const placed = state.placement?.rect ?? null
	const position =
		placed === null
			? null
			: placementPosition(
					{ x: placed[0], y: box[3] - placed[3], width: placed[2] - placed[0], height: placed[3] - placed[1] },
					{ width: box[2], height: box[3] }
				)

	return (
		<div
			role="group"
			tabIndex={0}
			aria-label={t("previewPdfRedactAreaSurface", { page: props.page + 1 })}
			className="absolute inset-0 cursor-crosshair touch-none outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
			onPointerDown={event => {
				if (event.button !== 0) return

				event.currentTarget.setPointerCapture(event.pointerId)
				step(event, "down")
			}}
			onPointerMove={event => {
				if (state.drag !== null) step(event, "move")
			}}
			onPointerUp={event => {
				if (state.drag !== null) step(event, "up")
			}}
			onPointerCancel={event => {
				step(event, "cancel")
			}}
			onKeyDown={onKeyDown}
		>
			{draft === null ? null : (
				<Draft
					props={props}
					rect={draft.rect}
				/>
			)}
			{position === null ? null : (
				<span
					className="sr-only"
					role="status"
					aria-live="polite"
				>
					{t("previewPdfPlacementPosition", position)}
				</span>
			)}
		</div>
	)
}

export function RedactTextOverlay(props: PdfToolOverlayProps) {
	const { t } = useTranslation("preview")
	const { session, stale } = useToolSession(props.context)
	const [lines, setLines] = useState<{ readonly page: number; readonly lines: readonly PdfTextGeometryLine[] } | null>(null)
	const [state, setState] = useState<MarkupState>(() => markupTool("Highlight"))
	const geometry = lines?.page === props.page ? lines.lines : null
	const lost = useEffectEvent(() => {
		stale()
	})

	// The page's text lines, read once the editor has the document.
	useEffect(() => {
		if (session === null) return

		let live = true

		void session.engine.call("textGeometry", { page: props.page }).then(
			read => {
				if (live) setLines({ page: props.page, lines: read })
			},
			() => {
				if (live) lost()
			}
		)

		return () => {
			live = false
		}
	}, [session, props.page])

	const step = (event: PointerEvent<HTMLDivElement>, type: ToolPointer["type"]): void => {
		if (geometry === null) return

		const next = markupPointer(state, pointer(event, type, props), {
			quads: (_page, from, to) => quadsFromLines(geometry, from, to)
		})

		setState(next.state)

		if (next.commit !== undefined) {
			const quads: readonly PdfQuad[] = next.commit.quads

			props.context.edit(current => current.dispatch("redact.markText", { page: props.page, quads }))
		}
	}

	return (
		<div
			role="group"
			aria-label={t("previewPdfRedactTextSurface", { page: props.page + 1 })}
			aria-busy={geometry === null}
			className="absolute inset-0 cursor-text touch-none"
			onPointerDown={event => {
				if (event.button !== 0) return

				event.currentTarget.setPointerCapture(event.pointerId)
				step(event, "down")
			}}
			onPointerMove={event => {
				if (state.drag !== null) step(event, "move")
			}}
			onPointerUp={event => {
				if (state.drag !== null) step(event, "up")
			}}
			onPointerCancel={event => {
				step(event, "cancel")
			}}
		>
			{state.drag?.quads.map((quad, index) => (
				<Draft
					// One drag's quads never reorder.
					key={index}
					props={props}
					rect={[Math.min(quad[0], quad[4]), Math.min(quad[1], quad[3]), Math.max(quad[2], quad[6]), Math.max(quad[5], quad[7])]}
				/>
			))}
		</div>
	)
}
