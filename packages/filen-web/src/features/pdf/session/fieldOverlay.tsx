import { useEffect, useState, type CSSProperties } from "react"
import { useTranslation } from "react-i18next"
import { pdfBox, type PdfViewport } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { isMupdfDocument, type PdfEditSnapshot } from "@filen/office/react/pdfedit"
import { cn } from "@filen/shared"
import { engineFields, fieldChecked, pdfjsFields, type OverlayField } from "@/features/pdf/session/fieldOverlay.logic"
import type { PdfEditSwap } from "@/features/pdf/session/swap"

// A page's form fields as controls over its rendering. Typing, choosing or ticking is a change: the first one starts
// the editor (the viewer's pdf.js page stays meanwhile, the field shows a busy outline), and the edit is committed to
// it when the field is left or Enter is pressed (a choice or a tick at once), as one undo step. The controls never
// carry the document's field names or ids, never ask for a password, and keep password managers and autofill out.

interface FieldOverlayProps {
	readonly document: PdfDomDocument
	// 1-based.
	readonly page: number
	readonly viewport: PdfViewport
	readonly swap: PdfEditSwap
	readonly snapshot: PdfEditSnapshot | null
	readonly starting: boolean
	readonly editable: boolean
}

// What a password manager or the browser's autofill must leave alone.
const NO_AUTOFILL = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" }

function boxStyle(viewport: PdfViewport, rect: OverlayField["rect"]): CSSProperties {
	const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1])
	const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3])
	const box = pdfBox(Number(x1), Number(y1), Number(x2), Number(y2))

	return { position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height }
}

export function PdfFieldOverlay({ document, page, viewport, swap, snapshot, starting, editable }: FieldOverlayProps) {
	const engine = isMupdfDocument(document)
	const [read, setRead] = useState<{ readonly document: PdfDomDocument; readonly fields: readonly OverlayField[] } | null>(null)
	const widgets = engine ? (snapshot?.widgets.get(page - 1) ?? null) : null
	const fields = engine ? (widgets === null ? null : engineFields(widgets)) : read?.document === document ? read.fields : null

	// The viewer's widgets, once per page read (pdf.js keeps the page's annotations).
	useEffect(() => {
		if (engine) return

		let live = true

		void document
			.getPage(page)
			.then(proxy => proxy.getAnnotations({ intent: "display" }))
			.then(
				annotations => {
					if (live) setRead({ document, fields: pdfjsFields(annotations) })
				},
				() => {
					// No controls: the page still shows its fields as drawn.
				}
			)

		return () => {
			live = false
		}
	}, [document, page, engine])

	// The editor's widgets of this page, read once it has the document.
	useEffect(() => {
		if (engine && snapshot !== null && widgets === null) {
			swap.withSession(session => {
				session.want([page - 1])
			})
		}
	}, [engine, snapshot, widgets, swap, page])

	if (fields === null || fields.length === 0) return null

	return (
		<div className="pointer-events-none absolute inset-0">
			{fields.map(field => (
				<FieldControl
					key={field.id}
					field={field}
					page={page - 1}
					style={boxStyle(viewport, field.rect)}
					swap={swap}
					starting={starting}
					editable={editable}
				/>
			))}
		</div>
	)
}

interface FieldControlProps {
	readonly field: OverlayField
	readonly page: number
	readonly style: CSSProperties
	readonly swap: PdfEditSwap
	readonly starting: boolean
	readonly editable: boolean
}

function FieldControl({ field, page, style, swap, starting, editable }: FieldControlProps) {
	const { t } = useTranslation("preview")
	// What was typed and not yet committed (or committed and not yet drawn by the engine); null: the field's value.
	const [draft, setDraft] = useState<string | null>(null)
	const disabled = !editable || field.readOnly
	const label = field.label.length > 0 ? field.label : t("previewPdfFieldLabel")
	const busy = starting && draft !== null
	const className = cn(
		"pointer-events-auto rounded-xs border-0 bg-transparent px-0.5 text-black outline-none focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-primary",
		busy && "outline-2 outline-primary outline-dashed"
	)

	// The engine drew the committed value: the draft goes.
	if (draft !== null && draft === field.value) setDraft(null)

	const commit = (value: string): void => {
		if (value === field.value) return

		swap.edit(session => session.dispatch("forms.setText", { page, widget: field.id, value }))
	}

	if (field.type === "checkbox" || field.type === "radio") {
		return (
			<input
				type={field.type === "radio" ? "radio" : "checkbox"}
				aria-label={label}
				aria-busy={busy}
				disabled={disabled}
				checked={fieldChecked(field)}
				className={cn(className, "m-0 cursor-pointer appearance-none")}
				style={style}
				onFocus={() => {
					swap.prefetch()
				}}
				onChange={() => {
					swap.edit(session => session.dispatch("forms.toggle", { page, widget: field.id }))
				}}
			/>
		)
	}

	if (field.type === "choice") {
		return (
			<select
				aria-label={label}
				aria-busy={busy}
				disabled={disabled}
				value={draft ?? field.value}
				className={cn(className, "cursor-pointer text-transparent focus-visible:text-black")}
				style={style}
				{...NO_AUTOFILL}
				onFocus={() => {
					swap.prefetch()
				}}
				onChange={event => {
					const value = event.target.value

					setDraft(value)
					swap.edit(session => session.dispatch("forms.setChoice", { page, widget: field.id, value }))
				}}
			>
				{field.options.map(option => (
					<option
						key={option}
						value={option}
					>
						{option}
					</option>
				))}
			</select>
		)
	}

	const shown = draft ?? field.value
	// Drawn by the engine once committed; the control shows the text only while it differs from the drawing.
	const textClass = cn(
		className,
		"leading-5",
		draft === null && "text-transparent caret-black focus-visible:text-black",
		draft !== null && "bg-white"
	)

	return field.multiline ? (
		<textarea
			aria-label={label}
			aria-busy={busy}
			disabled={disabled}
			value={shown}
			maxLength={field.maxLength > 0 ? field.maxLength : undefined}
			className={cn(textClass, "resize-none")}
			style={style}
			{...NO_AUTOFILL}
			spellCheck={false}
			onFocus={() => {
				swap.prefetch()
			}}
			onChange={event => {
				setDraft(event.target.value)
				swap.warm()
			}}
			onBlur={() => {
				if (draft !== null) commit(draft)
			}}
		/>
	) : (
		<input
			type="text"
			aria-label={label}
			aria-busy={busy}
			disabled={disabled}
			value={shown}
			maxLength={field.maxLength > 0 ? field.maxLength : undefined}
			className={textClass}
			style={style}
			{...NO_AUTOFILL}
			spellCheck={false}
			onFocus={() => {
				swap.prefetch()
			}}
			onChange={event => {
				setDraft(event.target.value)
				swap.warm()
			}}
			onBlur={() => {
				if (draft !== null) commit(draft)
			}}
			onKeyDown={event => {
				if (event.key === "Enter" && draft !== null) {
					event.preventDefault()
					commit(draft)
				}
			}}
		/>
	)
}
