import { useEffect, useEffectEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { matchPdfFont } from "@filen/office/core/pdfedit/fontMatch"
import { PdfEngineError, TEXT_EDIT_UNSAFE } from "@filen/office/dom/pdfedit"
import { narrowTarget, newTextFrame, type TextEditTarget } from "@filen/office/dom/pdfedit/textEdit/target"
import { PdfTextEditor } from "@/features/pdf/textEdit/pdfTextEditor"
import { PdfTextEditNotice } from "@/features/pdf/textEdit/pdfTextEditNotice"
import { changedSpan, displayTransform, surfaceToDisplay, type TextEditorSource } from "@/features/pdf/textEdit/textEdit.logic"
import { PdfNoticeLine } from "@/features/pdf/tools/noticeLine"
import { withPdfSession, type PdfToolContext, type PdfToolOverlayProps, type PdfToolPanelProps } from "@/features/pdf/tools/registry"
import { pdfToolState, usePdfToolState } from "@/features/pdf/tools/toolState"
import { log } from "@/lib/log"

// Tools › Edit text and Add text. A click on a page asks the editor what text is there (a block, laid out in lines);
// the in-place editor opens over it, prefilled, with the font it will be set in. Done replaces only the words that
// changed (their glyphs removed, the new words laid out in the matched font and grafted over the page) as one undo
// step; a change that would also remove nearby text is refused whole and said so. Add text places an empty editor
// where the page is clicked. Text drawn as shapes, in a Type 3 font, vertical or curved can't be edited (a notice).
// A document with accessibility tags is told once that its tags may be incomplete.

// New text's size and colour when added.
const ADD_SIZE = 12
const ADD_COLOR = 0x000000
const ADD_FONT = matchPdfFont({ name: "", bold: false, italic: false, serif: false, mono: false })

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

function notifyTextNotice(context: PdfToolContext, kind: "cantEdit" | "unsafe"): void {
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

function TextOverlay({ context, page, viewport, editing, mode }: PdfToolOverlayProps & { readonly mode: "edit" | "add" }) {
	const { t } = useTranslation("preview")
	const editor = usePdfToolState(editorState)
	const mine = editor?.page === page ? editor : null

	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox
	const pageWidth = x1 - x0
	const pageHeight = y1 - y0

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

		if (mode === "add") {
			const frame = newTextFrame([point[0], point[1]], ADD_SIZE)

			editorState.set({
				page,
				source: {
					text: "",
					frame,
					bounds: [point[0], point[1], point[0] + ADD_SIZE * 8, point[1] + ADD_SIZE],
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

			return
		}

		void withPdfSession(context, session => session.engine.call("textHit", { page, point })).then(
			hit => {
				if (hit.kind === "refused") notifyTextNotice(context, "cantEdit")
				else if (hit.kind === "target") {
					context.notify(null)
					editorState.set({ page, source: hit.target, target: hit.target, pageWidth, pageHeight, busy: false })
				}
			},
			(error: unknown) => {
				log.warn("pdf", "text hit-test failed", { error })
			}
		)
	}

	return (
		<div
			data-slot="pdf-text-tool"
			data-mode={mode}
			className="pointer-events-auto absolute inset-0 cursor-text"
			onPointerDown={onPointerDown}
		>
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
