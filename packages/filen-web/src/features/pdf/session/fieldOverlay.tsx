import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PDF_MASKED_CLASS, pdfBox, pdfFormControlProps, type PdfFormControlProps, type PdfViewport } from "@filen/office/dom/pdf"
import type { PdfFieldValue } from "@filen/office/dom/pdfedit/fillSign"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { isMupdfDocument, type PdfEditSnapshot } from "@filen/office/react/pdfedit"
import { cn } from "@filen/shared"
import {
	combSpacing,
	controlField,
	engineFields,
	fieldChecked,
	fieldEmpty,
	formOverlaySession,
	pdfjsFields,
	type FormOverlaySession,
	type OverlayField
} from "@/features/pdf/session/fieldOverlay.logic"
import type { PdfEditSwap } from "@/features/pdf/session/swap"

// A page's form fields as controls over its rendering, in the page's tab order. Typing, choosing or ticking is a
// change: the first one starts the editor (the viewer's pdf.js page stays meanwhile, the field shows a busy outline),
// and the edit is committed when the field is left or Enter is pressed (a choice or a tick at once), as one undo step.
// The controls follow the hardening contract (dom/pdf/formWidgets.ts): never the document's field names or ids, never
// type=password, password managers and autofill kept out, no <form>. A password field is shown masked and refuses
// typing (its value would be stored in the file). Text typed and not yet committed survives the page being drawn anew,
// and so does the focus.

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

// The font size of a control in CSS pixels: a share of its box's height, within what reads.
function fontSizeOf(height: number, multiline: boolean): number {
	return Math.max(6, Math.min(multiline ? 14 : height * 0.65, 18))
}

function boxOf(viewport: PdfViewport, rect: OverlayField["rect"]): ReturnType<typeof pdfBox> {
	const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1])
	const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3])

	return pdfBox(Number(x1), Number(y1), Number(x2), Number(y2))
}

export function PdfFieldOverlay({ document, page, viewport, swap, snapshot, starting, editable }: FieldOverlayProps) {
	const engine = isMupdfDocument(document)
	const [read, setRead] = useState<{ readonly document: PdfDomDocument; readonly fields: readonly OverlayField[] } | null>(null)
	const widgets = engine ? (snapshot?.widgets.get(page - 1) ?? null) : null
	// The viewer's fields stay until the editor's are read (the swap keeps the controls, their focus and drafts).
	const fields =
		engine && widgets !== null ? engineFields(widgets) : engine || read?.document === document ? (read?.fields ?? null) : null
	const form = formOverlaySession(swap)
	const warned = useSyncExternalStore(form.subscribe, form.requiredWarned)

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
					viewport={viewport}
					swap={swap}
					form={form}
					starting={starting}
					editable={editable}
					warned={warned}
				/>
			))}
		</div>
	)
}

interface FieldControlProps {
	readonly field: OverlayField
	readonly page: number
	readonly viewport: PdfViewport
	readonly swap: PdfEditSwap
	readonly form: FormOverlaySession
	readonly starting: boolean
	readonly editable: boolean
	readonly warned: boolean
}

type ControlElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

// The attributes every control spreads (React names): the description's, but its element and masking (which the
// control applies itself).
function domProps(props: PdfFormControlProps, id: string) {
	return {
		type: props.type,
		name: props.name,
		id,
		autoComplete: props.autoComplete,
		autoCapitalize: props.autoCapitalize,
		autoCorrect: props.autoCorrect,
		spellCheck: props.spellCheck,
		readOnly: props.readOnly,
		disabled: props.disabled,
		required: props.required,
		multiple: props.multiple,
		maxLength: props.maxLength,
		"aria-label": props["aria-label"],
		"data-1p-ignore": props["data-1p-ignore"],
		"data-lpignore": props["data-lpignore"],
		"data-bwignore": props["data-bwignore"],
		"data-form-type": props["data-form-type"],
		"data-protonpass-ignore": props["data-protonpass-ignore"],
		"data-filen-hardened": props["data-filen-hardened"],
		"data-pdf-field": ""
	}
}

// A control holding a text selection (a text input or a text area).
function textControl(node: ControlElement | null): HTMLInputElement | HTMLTextAreaElement | null {
	return node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && node.type === "text") ? node : null
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

function FieldControl({ field, page, viewport, swap, form, starting, editable, warned }: FieldControlProps) {
	const { t } = useTranslation("preview")
	const element = useRef<ControlElement | null>(null)
	// What was typed or chosen and not yet drawn by the engine; null: the field's value.
	const [draft, setDraft] = useState<string | null>(() => form.draft(field.id)?.text ?? null)
	const [chosen, setChosen] = useState<readonly string[] | null>(null)
	const props = pdfFormControlProps(controlField(field), form.scope, t("previewPdfFieldLabel"))
	// One element id for the control's life (a datalist is tied to it).
	const [id] = useState(() => props.id)
	const box = boxOf(viewport, field.rect)
	const fontSize = fontSizeOf(box.height, field.multiline)
	const locked = !editable || field.readOnly
	const busy = starting && draft !== null
	const invalid = warned && field.required && fieldEmpty(field)
	const style: CSSProperties = {
		position: "absolute",
		left: box.left,
		top: box.top,
		width: box.width,
		height: box.height,
		fontSize,
		...(field.comb && field.maxLength > 0 ? { fontFamily: "monospace", ...combSpacing(box.width, field.maxLength, fontSize) } : {})
	}
	const className = cn(
		"pointer-events-auto m-0 rounded-xs border-0 bg-transparent px-0.5 text-black outline-none focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-primary",
		busy && "outline-2 outline-primary outline-dashed",
		invalid && "ring-2 ring-destructive"
	)
	const attributes = {
		...domProps(props, id),
		"aria-busy": busy,
		"aria-invalid": invalid,
		onFocus: () => {
			swap.prefetch()
		}
	}

	// The engine drew the committed value: the draft goes.
	if (draft !== null && draft === field.value) setDraft(null)

	if (chosen !== null && sameValues(chosen, field.selected)) setChosen(null)

	// The draft outlives the control (its page is drawn anew on every change), and a save commits it.
	useEffect(() => {
		form.setDraft(field.id, draft === null ? null : { page, text: draft })
	}, [form, field.id, page, draft])

	// The focus comes back to the control that had it when the page was drawn anew (every change redraws), and is
	// noted when this control goes with the focus on it.
	useLayoutEffect(() => {
		const node = element.current
		const text = textControl(node)
		const refocus = node === null ? null : form.takeFocus(field.id)

		if (node !== null && refocus !== null) {
			node.focus({ preventScroll: true })

			if (text !== null && refocus.start !== null && refocus.end !== null) text.setSelectionRange(refocus.start, refocus.end)
		}

		return () => {
			if (node?.ownerDocument.activeElement === node) {
				form.noteFocus({ widget: field.id, start: text?.selectionStart ?? null, end: text?.selectionEnd ?? null })
			}
		}
	}, [form, field.id])

	const dispatch = (value: PdfFieldValue): void => {
		swap.edit(session => session.dispatch("forms.setField", { page, widget: field.id, value }))
	}

	const commit = (): void => {
		if (draft === null || draft === field.value) return

		dispatch({ kind: "text", text: draft })
	}

	// Escape takes typed text back (and stays in the field); without any, it is the viewer's.
	const onEscape = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && draft !== null) {
			event.preventDefault()
			event.stopPropagation()
			setDraft(null)
		}
	}

	if (field.password) {
		const refuse = (): void => {
			toast.info(t("previewPdfFormPassword"), { id: "pdf-form-password" })
		}

		return (
			<input
				ref={node => {
					element.current = node
				}}
				{...attributes}
				type="text"
				readOnly
				value={field.value}
				className={cn(className, PDF_MASKED_CLASS, "text-transparent focus-visible:text-black")}
				style={style}
				title={t("previewPdfFormPassword")}
				onClick={refuse}
				onKeyDown={event => {
					if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) refuse()
				}}
				onPaste={event => {
					event.preventDefault()
					refuse()
				}}
				onDrop={event => {
					event.preventDefault()
					refuse()
				}}
			/>
		)
	}

	if (field.kind === "checkbox" || field.kind === "radio") {
		const checked = fieldChecked(field)

		return (
			<input
				ref={node => {
					element.current = node
				}}
				{...attributes}
				disabled={locked}
				checked={checked}
				className={cn(className, "cursor-pointer appearance-none")}
				style={style}
				onChange={() => {
					dispatch(field.kind === "radio" ? { kind: "radio" } : { kind: "checkbox", checked: !checked })
				}}
			/>
		)
	}

	if (field.kind === "list" || (field.kind === "combo" && !field.editable)) {
		const shown = chosen ?? (field.selected.length > 0 ? field.selected : field.value === "" ? [] : [field.value])
		const multiple = field.kind === "list" && field.multiSelect
		const known = field.options.some(option => option.value === (shown[0] ?? ""))

		return (
			<select
				ref={node => {
					element.current = node
				}}
				{...attributes}
				disabled={locked}
				multiple={multiple}
				size={field.kind === "list" ? Math.max(2, field.options.length) : undefined}
				value={multiple ? [...shown] : (shown[0] ?? "")}
				className={cn(
					className,
					"cursor-pointer text-transparent focus-visible:text-black",
					field.kind === "list" && "overflow-hidden [&:not(:focus)_option]:bg-transparent"
				)}
				style={style}
				onChange={event => {
					const values = Array.from(event.currentTarget.selectedOptions, option => option.value).filter(value => value !== "")

					setChosen(values)
					dispatch({ kind: "choice", values })
				}}
			>
				{/* A combo box with nothing chosen (or a value that is no option) shows nothing. */}
				{field.kind === "combo" && !known ? <option value={shown[0] ?? ""} /> : null}
				{field.options.map(option => (
					<option
						key={option.value}
						value={option.value}
					>
						{option.label}
					</option>
				))}
			</select>
		)
	}

	const shown = draft ?? field.value
	// Drawn by the engine once committed; the control shows the text only while it differs from the drawing.
	const textClass = cn(className, draft === null && "text-transparent caret-black focus-visible:text-black", draft !== null && "bg-white")
	const onChange = (value: string): void => {
		setDraft(value)
		swap.warm()
	}
	const onBlur = (event: { readonly currentTarget: Element }): void => {
		// A control taken down with its page keeps its draft for when it is back.
		if (event.currentTarget.isConnected) commit()
	}

	if (field.multiline) {
		return (
			<textarea
				ref={node => {
					element.current = node
				}}
				{...attributes}
				readOnly={locked}
				value={shown}
				className={cn(textClass, "resize-none")}
				style={style}
				onChange={event => {
					onChange(event.target.value)
				}}
				onBlur={onBlur}
				onKeyDown={event => {
					onEscape(event)

					// Enter is a new line; Mod+Enter commits.
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault()
						commit()
					}
				}}
			/>
		)
	}

	const listId = `${id}-options`

	return (
		<>
			<input
				ref={node => {
					element.current = node
				}}
				{...attributes}
				type="text"
				readOnly={locked}
				value={shown}
				list={field.kind === "combo" ? listId : undefined}
				className={textClass}
				style={style}
				onChange={event => {
					onChange(event.target.value)
				}}
				onBlur={onBlur}
				onKeyDown={event => {
					onEscape(event)

					if (event.key === "Enter") {
						event.preventDefault()
						commit()
					}
				}}
			/>
			{field.kind === "combo" ? (
				<datalist id={listId}>
					{field.options.map(option => (
						<option
							key={option.value}
							value={option.value}
						>
							{option.label}
						</option>
					))}
				</datalist>
			) : null}
		</>
	)
}
