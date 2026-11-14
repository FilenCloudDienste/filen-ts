import { useEffect, useEffectEvent, useId, useState, type CSSProperties, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { pdfBox, type PdfViewport } from "@filen/office/dom/pdf"
import { placementPosition, placementStart, useKeyboardPlacement, type PlacementRect } from "@filen/office/react/pdfedit"
import { useOfficeSettings } from "@/features/office/lib/officeSettings"
import { SignatureDialog } from "@/features/pdf/fillSign/signatureDialog"
import { useAnnouncement } from "@/features/pdf/tools/liveRegion"
import { fillSignChoice, setFillSignChoice, useFillSignChoice } from "@/features/pdf/fillSign/fillSignChoice"
import {
	FILL_TEXT_BOX,
	FILL_TEXT_SIZE,
	lineWidths,
	markSize,
	pageBox,
	signatureSize,
	textBox,
	type FillSignMode
} from "@/features/pdf/fillSign/fillSign.logic"
import type { PdfToolOverlayProps, PdfToolPanelProps } from "@/features/pdf/tools/registry"
import "@filen/office/css/pdfedit.css"

// Fill & Sign on the page: while a Fill & Sign tool is active, each page shown is a surface it is placed on, with the
// pointer (a click puts it there, centred) or the keyboard (Enter on the focused page puts it at the centre, the
// arrows move it, Shift ×10, Alt resizes, Enter places, Escape cancels; the indicator and a live region say where).
// Text opens a box to type into at that point (Enter adds it, Shift+Enter a new line, Escape drops it); a mark is
// added at once; a signature or initials is chosen first in the signature dialog (the tool's panel), then placed once.
// Everything is drawn only once the editor has the document (the tool starts it), so the viewport is the editor's:
// its view box is the page's [0, 0, width, height].

const BLACK = [0, 0, 0] as const

function viewportRect(viewport: PdfViewport, rect: PlacementRect): CSSProperties {
	const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y)
	const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height)
	const box = pdfBox(Number(x1), Number(y1), Number(x2), Number(y2))

	return { position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height }
}

export interface FillSignOverlayProps extends PdfToolOverlayProps {
	readonly mode: FillSignMode
}

export function FillSignOverlay({ mode, context, page, viewport, editing }: FillSignOverlayProps) {
	const { t } = useTranslation("preview")
	const settings = useOfficeSettings()
	const choice = useFillSignChoice()
	const hintId = useId()
	const pageSize = { width: viewport.viewBox[2] ?? 0, height: viewport.viewBox[3] ?? 0 }
	const signature = mode.kind === "signature" && choice?.role === mode.role ? choice.signature : null
	const size =
		mode.kind === "text"
			? FILL_TEXT_BOX
			: mode.kind === "mark"
				? markSize(mode.mark)
				: signature === null
					? FILL_TEXT_BOX
					: signatureSize(signature, mode.role)
	// Text being typed at a placed box.
	const [editor, setEditor] = useState<{ readonly rect: PlacementRect; readonly text: string } | null>(null)
	const author = settings.authorName ?? ""

	const place = (rect: PlacementRect): void => {
		const box = pageBox(rect, pageSize.height)

		if (mode.kind === "text") {
			setEditor({ rect, text: "" })
		} else if (mode.kind === "mark") {
			context.edit(session => session.dispatch("fillSign.mark", { page, box, mark: mode.mark, color: BLACK, author }))
		} else if (signature !== null) {
			context.edit(session => session.dispatch("fillSign.signature", { page, box, role: mode.role, signature, author }))
			setFillSignChoice(null)
			context.finish()
		}
	}

	const placement = useKeyboardPlacement({ page: pageSize, size, onCommit: place })

	useAnnouncement(
		context.swap,
		placement.rect === null ? null : t("previewPdfPlacementPosition", placementPosition(placement.rect, pageSize))
	)

	const commitText = (): void => {
		if (editor === null) return

		setEditor(null)

		const text = editor.text.replace(/\r\n?/gu, "\n")

		if (text.trim() === "") return

		const rect = textBox(editor.rect, lineWidths(text, FILL_TEXT_SIZE), FILL_TEXT_SIZE)

		context.edit(session =>
			session.dispatch("fillSign.text", {
				page,
				box: pageBox(rect, pageSize.height),
				text,
				font: "sans",
				size: FILL_TEXT_SIZE,
				color: BLACK,
				author
			})
		)
	}

	if (!editing || (mode.kind === "signature" && signature === null)) return null

	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		if (editor !== null) return

		const bounds = event.currentTarget.getBoundingClientRect()
		const [x, y] = viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top)

		place(placementStart(pageSize, size, { x: Number(x), y: Number(y) }))
	}

	return (
		<div className="absolute inset-0">
			{/* The page as the tool's target: focusable for keyboard placement, a click places. */}
			<div
				role="application"
				tabIndex={0}
				aria-label={t("previewPdfFillPlaceOnPage", { page: page + 1 })}
				aria-describedby={hintId}
				className="absolute inset-0 cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-primary"
				onClick={onClick}
				onKeyDown={event => {
					if (editor !== null || placement.onKeyDown(event)) return

					if (event.key === "Enter" && placement.rect === null) {
						event.preventDefault()
						placement.start()
					} else if (event.key === "Escape" && placement.rect === null) {
						event.preventDefault()
						event.stopPropagation()
						context.finish()
					}
				}}
			/>
			<span
				id={hintId}
				hidden
			>
				{t("previewPdfFillPlaceHint")}
			</span>
			{placement.rect === null ? null : (
				<div
					className="fo-pdf-tool-placement pointer-events-none"
					style={viewportRect(viewport, placement.rect)}
					aria-hidden="true"
				/>
			)}
			{editor === null ? null : (
				<textarea
					aria-label={t("previewPdfFillTextLabel")}
					// The box was placed by the user's own gesture: typing starts at once.
					autoFocus
					value={editor.text}
					className="fo-pdf-tool-text-editor resize-none bg-white/80 text-black"
					style={{
						...viewportRect(viewport, editor.rect),
						minWidth: FILL_TEXT_BOX.width * viewport.scale,
						fontSize: FILL_TEXT_SIZE * viewport.scale,
						fontFamily: "Helvetica, Arial, sans-serif",
						lineHeight: 1.2
					}}
					onChange={event => {
						setEditor({ rect: editor.rect, text: event.currentTarget.value })
					}}
					onBlur={commitText}
					onKeyDown={event => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault()
							commitText()
						} else if (event.key === "Escape") {
							event.preventDefault()
							event.stopPropagation()
							setEditor(null)
						}
					}}
				/>
			)}
		</div>
	)
}

// The Sign tools' panel: the editor is started at once (so the pages are the editor's when the signature is placed),
// and the signature dialog asks for the signature or initials; closing it without one ends the tool.
function SignaturePanel({ context, role }: PdfToolPanelProps & { readonly role: "signature" | "initials" }) {
	const settings = useOfficeSettings()
	const choice = useFillSignChoice()
	const start = useEffectEvent(() => {
		context.edit(() => Promise.resolve())
	})

	useEffect(() => {
		start()

		return () => {
			setFillSignChoice(null)
		}
	}, [])

	return (
		<SignatureDialog
			open={choice?.role !== role}
			role={role}
			defaultName={settings.authorName ?? undefined}
			onPlace={signature => {
				setFillSignChoice({ role, signature })
			}}
			onOpenChange={open => {
				// Closed by Place (the choice is made) or dismissed (the tool ends).
				if (!open && fillSignChoice()?.role !== role) context.finish()
			}}
		/>
	)
}

export function FillSignSignaturePanel(props: PdfToolPanelProps) {
	return (
		<SignaturePanel
			{...props}
			role="signature"
		/>
	)
}

export function FillSignInitialsPanel(props: PdfToolPanelProps) {
	return (
		<SignaturePanel
			{...props}
			role="initials"
		/>
	)
}

// The text and mark tools' panel: starts the editor (their overlays draw on its pages).
export function FillSignStartPanel({ context }: PdfToolPanelProps) {
	const start = useEffectEvent(() => {
		context.edit(() => Promise.resolve())
	})

	useEffect(() => {
		start()
	}, [])

	return null
}
