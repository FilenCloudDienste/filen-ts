import { useEffect, useEffectEvent, useId, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { matchPdfFont } from "@filen/office/core/pdfedit/fontMatch"
import { PdfEngineError, TEXT_EDIT_UNSAFE } from "@filen/office/dom/pdfedit"
import { narrowTarget, newTextFrame, type TextEditTarget } from "@filen/office/dom/pdfedit/textEdit/target"
import { placementPosition, useKeyboardPlacement } from "@filen/office/react/pdfedit"
import { PdfTextEditor } from "@/features/pdf/textEdit/pdfTextEditor"
import { PdfTextEditNotice, type PdfTextEditNoticeKind } from "@/features/pdf/textEdit/pdfTextEditNotice"
import {
	changedSpan,
	displayToSurface,
	displayTransform,
	surfaceToDisplay,
	type TextEditorSource
} from "@/features/pdf/textEdit/textEdit.logic"
import { useAnnouncement } from "@/features/pdf/tools/liveRegion"
import { PdfNoticeLine } from "@/features/pdf/tools/noticeLine"
import { withPdfSession, type PdfToolContext, type PdfToolOverlayProps, type PdfToolPanelProps } from "@/features/pdf/tools/registry"
import { pdfToolState, usePdfToolState } from "@/features/pdf/tools/toolState"
import { log } from "@/lib/log"

// Tools › Edit text and Add text. A click on a page (or Enter on the focused page, a marker moved with the arrows, then
// Enter) asks the editor what text is there (a block, laid out in lines);
// the in-place editor opens over it, prefilled, with the font it will be set in. Done replaces only the words that
// changed (their glyphs removed, the new words laid out in the matched font and grafted over the page) as one undo
// step; a change that would also remove nearby text is refused whole and said so. Add text places an empty editor
// where the page is clicked. Text drawn as shapes, in a Type 3 font, vertical or curved can't be edited (a notice).
// A document with accessibility tags is told once that its tags may be incomplete.

// New text's size and colour when added.
const ADD_SIZE = 12
const ADD_COLOR = 0x000000
const ADD_FONT = matchPdfFont({ name: "", bold: false, italic: false, serif: false, mono: false })
// New text's first box (points), and the marker Edit text is placed with from the keyboard.
const ADD_BOX = { width: ADD_SIZE * 8, height: ADD_SIZE }
const EDIT_MARKER = { width: 8, height: 8 }

interface OpenEditor {
	readonly page: number
	readonly source: TextEditorSource
	// What the editor replaces; null: new text at `source.frame`.
	readonly target: TextEditTarget | null
	readonly pageWidth: number
	readonly pageHeight: number
	readonly busy: boolean
}

const editorState = pdfToolState<OpenEditor | null>(null)
// The tagged notice is said once while the tool is chosen.
let taggedTold = false

interface ApplyWords {
	readonly failed: string
	readonly tagged: string
}

function notifyTextNotice(context: PdfToolContext, kind: PdfTextEditNoticeKind): void {
	context.notify(
		<PdfTextEditNotice
			kind={kind}
			onDismiss={() => {
				context.notify(null)
			}}
		/>
	)
}

function isUnsafe(error: unknown): boolean {
	return error instanceof PdfEngineError && error.failure === "notAllowed" && error.message === TEXT_EDIT_UNSAFE
}

// What Done replaces: the changed words of the target (or all of it when the change crosses lines), with what.
function replacement(target: TextEditTarget, text: string): { readonly target: TextEditTarget; readonly text: string } | null {
	const change = changedSpan(target.text, text)

	if (change === null) return null

	const narrowed = target.text.slice(change.start, change.end).includes("\n") ? null : narrowTarget(target, change.start, change.end)

	return narrowed === null ? { target, text } : { target: narrowed, text: change.text }
}

async function apply(context: PdfToolContext, editor: OpenEditor, text: string, words: ApplyWords): Promise<void> {
	editorState.set({ ...editor, busy: true })

	try {
		const tagged = await withPdfSession(context, async session => {
			const target = editor.target

			if (target === null) {
				const overlay = await session.engine.call("textPrepare", {
					source: { ...editor.source, pageWidth: editor.pageWidth, pageHeight: editor.pageHeight },
					text,
					style: {}
				})

				if (overlay !== null) await session.dispatch("textEdit.add", { page: editor.page, overlay })
			} else {
				const change = replacement(target, text)

				if (change === null) return false

				const overlay = await session.engine.call("textPrepare", { source: change.target, text: change.text, style: {} })

				await session.dispatch("textEdit.replace", { page: editor.page, chars: change.target.chars, overlay })
			}

			return session.getSnapshot().state.tagged
		})

		if (tagged && !taggedTold) {
			taggedTold = true
			context.notify(
				<PdfNoticeLine
					onDismiss={() => {
						context.notify(null)
					}}
				>
					{words.tagged}
				</PdfNoticeLine>
			)
		}
	} catch (error) {
		if (isUnsafe(error)) notifyTextNotice(context, "unsafe")
		else {
			log.warn("pdf", "text edit failed", { error })
			toast.error(words.failed)
		}
	}

	editorState.set(null)
}

// The surface box (CSS px over the page) of a display-space rect (points, origin top left), at any view turn.
function surfaceBox(viewport: PdfToolOverlayProps["viewport"], rect: readonly [number, number, number, number]): CSSProperties {
	const corners = [
		displayToSurface(viewport, rect[0], rect[1]),
		displayToSurface(viewport, rect[2], rect[1]),
		displayToSurface(viewport, rect[0], rect[3]),
		displayToSurface(viewport, rect[2], rect[3])
	]
	const xs = corners.map(corner => corner[0])
	const ys = corners.map(corner => corner[1])
	const left = Math.min(...xs)
	const top = Math.min(...ys)

	return { position: "absolute", left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

function TextOverlay({ context, page, viewport, editing, mode }: PdfToolOverlayProps & { readonly mode: "edit" | "add" }) {
	const { t } = useTranslation("preview")
	const editor = usePdfToolState(editorState)
	const mine = editor?.page === page ? editor : null
	const hintId = useId()

	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox
	const pageWidth = x1 - x0
	const pageHeight = y1 - y0
	const pageSize = { width: pageWidth, height: pageHeight }

	// An empty editor for new text whose first line starts at `point` (display space).
	const openAdd = (point: readonly [number, number]): void => {
		editorState.set({
			page,
			source: {
				text: "",
				frame: newTextFrame([point[0], point[1]], ADD_SIZE),
				bounds: [point[0], point[1], point[0] + ADD_BOX.width, point[1] + ADD_BOX.height],
				angle: 0,
				size: ADD_SIZE,
				color: ADD_COLOR,
				font: ADD_FONT
			},
			target: null,
			pageWidth,
			pageHeight,
			busy: false
		})
	}

	// The editor over the text at `point` (display space), or the notice saying why there is none.
	const editAt = (point: readonly [number, number]): void => {
		void withPdfSession(context, session => session.engine.call("textHit", { page, point: [point[0], point[1]] })).then(
			hit => {
				if (hit.kind === "refused") notifyTextNotice(context, "cantEdit")
				else if (hit.kind === "none") notifyTextNotice(context, "noText")
				else {
					context.notify(null)
					editorState.set({ page, source: hit.target, target: hit.target, pageWidth, pageHeight, busy: false })
				}
			},
			(error: unknown) => {
				log.error("pdf", "text hit-test failed", { error })
				toast.error(t("previewPdfTextEditHitFailed"))
			}
		)
	}

	// Keyboard placement (the shared one: Enter on the focused page, arrows move, Enter places, Escape cancels): Add
	// text opens its editor where the box was placed, Edit text edits the text under the marker's centre.
	const placement = useKeyboardPlacement({
		page: pageSize,
		size: mode === "add" ? ADD_BOX : EDIT_MARKER,
		onCommit: rect => {
			const top = pageHeight - rect.y - rect.height

			if (mode === "add") openAdd([rect.x, top])
			else editAt([rect.x + rect.width / 2, top + rect.height / 2])
		}
	})

	useAnnouncement(
		context.swap,
		placement.rect === null ? null : t("previewPdfPlacementPosition", placementPosition(placement.rect, pageSize))
	)

	const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
		if (!editing || event.button !== 0 || editor?.busy === true) return

		// A click beside an open editor closes it, unchanged.
		if (editor !== null) {
			editorState.set(null)

			return
		}

		const box = event.currentTarget.getBoundingClientRect()
		const point = surfaceToDisplay(viewport, event.clientX - box.left, event.clientY - box.top)

		event.preventDefault()

		if (mode === "add") openAdd(point)
		else editAt(point)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.target !== event.currentTarget || !editing || editor !== null) return
		if (placement.onKeyDown(event)) return

		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault()
			placement.start()
		}
	}

	const marker = placement.rect
	const indicator =
		marker === null
			? null
			: surfaceBox(viewport, [marker.x, pageHeight - marker.y - marker.height, marker.x + marker.width, pageHeight - marker.y])

	return (
		<div
			data-slot="pdf-text-tool"
			data-mode={mode}
			role="application"
			tabIndex={0}
			aria-label={t(mode === "add" ? "previewPdfTextAddOnPage" : "previewPdfTextEditOnPage", { page: page + 1 })}
			aria-describedby={hintId}
			className="pointer-events-auto absolute inset-0 cursor-text outline-none focus-visible:ring-2 focus-visible:ring-primary"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
		>
			<span
				id={hintId}
				hidden
			>
				{t(mode === "add" ? "previewPdfAnnotPlacementHint" : "previewPdfTextEditPlaceHint")}
			</span>
			{indicator === null ? null : (
				<div
					aria-hidden="true"
					className="fo-pdf-tool-placement pointer-events-none"
					style={indicator}
				/>
			)}
			{mine === null ? null : (
				<div
					className="absolute top-0 left-0"
					style={{ transform: displayTransform(viewport), transformOrigin: "0 0" }}
					onPointerDown={event => {
						// Typing and selecting in the editor never reach the page under it.
						event.stopPropagation()
					}}
				>
					<PdfTextEditor
						key={`${String(mine.source.frame.origin[0])}:${String(mine.source.frame.origin[1])}`}
						source={mine.source}
						scale={viewport.scale}
						busy={mine.busy}
						onDone={text => {
							if (text === mine.source.text) editorState.set(null)
							else void apply(context, mine, text, { failed: t("previewPdfChangeFailed"), tagged: t("previewPdfTagged") })
						}}
						onCancel={() => {
							editorState.set(null)
						}}
					/>
				</div>
			)}
		</div>
	)
}

// Mounted while a text tool is chosen: choosing it starts the editor (the tools work on its document); the open editor
// and the tool's notices go with it.
export function TextToolPanel({ context }: PdfToolPanelProps) {
	const start = useEffectEvent(() => {
		context.edit(() => Promise.resolve())
	})
	const end = useEffectEvent(() => {
		editorState.set(null)
		taggedTold = false
		context.notify(null)
	})

	useEffect(() => {
		start()

		return () => {
			end()
		}
	}, [])

	return null
}

export function EditTextOverlay(props: PdfToolOverlayProps) {
	return (
		<TextOverlay
			{...props}
			mode="edit"
		/>
	)
}

export function AddTextOverlay(props: PdfToolOverlayProps) {
	return (
		<TextOverlay
			{...props}
			mode="add"
		/>
	)
}
