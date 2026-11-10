import { useEffect, useId, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	equationLatex,
	latexPreview,
	selectEquation,
	type DocxEquationContext,
	type DocxLatexPreview,
	type LatexError
} from "@filen/office/core/docx/edit"
import { paintMath, type DocxObjectPress } from "@filen/office/react/docx/editor"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { useInputForm } from "@/features/preview/components/docxEditor.logic"
import { isImeKeydown, isMacPlatform, matchesCombo } from "@filen/shared/keymap"
import type { DocxObjectControlProps } from "@/features/preview/components/docxFormControls"

const IS_MAC = isMacPlatform()

// Equations as LaTeX in a popover at the equation: a new one typed at the caret (inline, or on a line of its own),
// one of the document opened by a press on it (or Edit equation) to change it (with changes tracked, recorded
// inside it), and one that cannot change here (a view-only document) shown with its LaTeX when it is selected. The preview is the typed
// LaTeX read as the saved equation is read back, painted once per frame.

type Mode = "insert" | "edit" | "view"

interface Opened {
	readonly mode: Mode
	// Where it is anchored: px from the container's top left.
	readonly x: number
	readonly y: number
	// The LaTeX it opened with (an unchanged equation is left as it is).
	readonly initial: string
	readonly lossy: boolean
	// An equation's own line (a new one's is the switch's).
	readonly display: boolean
	// The equation's position (edit, view).
	readonly pos: number
}

// What the popover shows: where and for what it opened, the LaTeX typed, and the line switch (a new one's).
interface Draft {
	readonly opened: Opened
	readonly latex: string
	readonly display: boolean
}

interface Taken {
	readonly press: DocxObjectPress | null
	// The request a press closed (it is done once the press is taken).
	readonly closed: number | null
	readonly equation: DocxEquationContext | null
}

function draftOf(opened: Opened): Draft {
	return { opened, latex: opened.initial, display: false }
}

const FIELD_CLASS =
	"min-h-16 w-full resize-y rounded-xl border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"

// A point of the pages (page px of page `page`) on screen; undefined while the page is not shown.
function pagePoint(props: DocxObjectControlProps, page: number, x: number, y: number): { x: number; y: number } | undefined {
	const element = props.container?.querySelector(`[data-fo-page="${String(page)}"]`)

	if (element === null || element === undefined) {
		return undefined
	}

	const rect = element.getBoundingClientRect()

	return { x: rect.left + x * props.zoom, y: rect.top + y * props.zoom }
}

// Where the selection ends on screen: on the pages from the layout, in the reflowed view from the browser.
function selectionPoint(props: DocxObjectControlProps): { x: number; y: number } | undefined {
	if (props.surface === "reflow") {
		const selection = window.getSelection()
		const rect = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : undefined

		return rect === undefined || (rect.width === 0 && rect.height === 0) ? undefined : { x: rect.left, y: rect.bottom }
	}

	const end = props.editor.ends().end

	return end === undefined ? undefined : pagePoint(props, end.page, end.x, end.top + end.height)
}

// Under a pressed equation's box (its press point where it has none on the pages).
function pressPoint(props: DocxObjectControlProps, press: DocxObjectPress): { x: number; y: number } {
	const box = press.hit.box

	return (
		(props.surface === "pages" && box !== undefined ? pagePoint(props, press.page, box.x, box.y + box.height) : undefined) ?? {
			x: press.clientX,
			y: press.clientY
		}
	)
}

function errorMessage(t: TFunction<"preview">, error: LatexError): string {
	const values = { token: error.token ?? "", position: error.offset + 1 }

	switch (error.code) {
		case "tooLong":
			return t("previewDocxEquationErrorTooLong")
		case "tooDeep":
			return t("previewDocxEquationErrorTooDeep", values)
		case "unknownCommand":
			return t("previewDocxEquationErrorUnknownCommand", values)
		case "missingArgument":
			return t("previewDocxEquationErrorMissingArgument", values)
		case "unbalanced":
			return t("previewDocxEquationErrorUnbalanced", values)
		case "unexpected":
		case "empty":
			return t("previewDocxEquationErrorUnexpected", values)
	}
}

function sameError(a: LatexError | null, b: LatexError | null): boolean {
	return a === b || (a !== null && b !== null && a.code === b.code && a.offset === b.offset && a.token === b.token)
}

// An equation's preview painted, or nothing when it cannot be (kept outside the component: the React Compiler
// compiles no value blocks inside a try/catch).
function paintedPreview(tree: DocxLatexPreview["tree"], document: Document): Element | undefined {
	if (tree === null) {
		return undefined
	}

	try {
		return paintMath(tree, document)
	} catch {
		return undefined
	}
}

export function DocxEquationPopover(props: DocxObjectControlProps) {
	const { editor, snapshot, container, readOnly, execute, press, onPressDone, inputRequest, onInputDone } = props
	const { t } = useTranslation("preview")
	const fieldId = useId()
	// Opened by a press or a selection (Insert / Edit equation's input is the request's form).
	const [own, setOwn] = useState<Draft | null>(null)
	// The error of the LaTeX of the draft opened as `opened` (another draft's is none).
	const [checked, setChecked] = useState<{ readonly opened: Opened; readonly error: LatexError | null } | null>(null)
	const [preview, setPreview] = useState<HTMLDivElement | null>(null)
	const [taken, setTaken] = useState<Taken>({ press: null, closed: null, equation: null })
	const equation = snapshot?.context.equation ?? null
	// Equations can change here (while changes are tracked too: recorded inside them).
	const changeable = !readOnly && snapshot !== undefined && !snapshot.readOnly
	const insertable = changeable && snapshot.enabled["equation.insert"]
	const editable = changeable && snapshot.enabled["equation.edit"]
	const at = (point: { x: number; y: number } | undefined): { x: number; y: number } => {
		const rect = container?.getBoundingClientRect()
		const shown = point ?? { x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + 48 }

		return { x: shown.x - (rect?.left ?? 0), y: shown.y - (rect?.top ?? 0) }
	}
	// Insert equation at the caret, Edit equation of the one selected: held until the popover closes (null: not
	// one this popover can take, told done at once).
	const asked = useInputForm<Draft>(
		inputRequest,
		request => request.type === "equation.insert" || request.type === "equation.edit",
		request => {
			if (request.type === "equation.insert") {
				return insertable
					? draftOf({ mode: "insert", ...at(selectionPoint(props)), initial: "", lossy: false, display: false, pos: -1 })
					: null
			}

			return equation === null
				? null
				: draftOf({
						mode: editable ? "edit" : "view",
						...at(selectionPoint(props)),
						initial: equation.latex,
						lossy: equation.lossy,
						display: equation.display,
						pos: equation.pos
					})
		}
	)
	const draft = asked.form ?? own
	const opened = draft?.opened ?? null
	const latex = draft?.latex ?? ""
	const display = draft?.display ?? false
	const error = checked !== null && checked.opened === opened ? checked.error : null
	const update = (change: (draft: Draft) => Draft): void => {
		if (asked.form !== null) {
			asked.setForm(change)
		} else {
			setOwn(previous => (previous === null ? null : change(previous)))
		}
	}
	const open = (next: Opened): void => {
		setOwn(draftOf(next))
	}

	// Taken while rendering, told done (and the equation selected) after.
	if (press !== null && press.hit.kind === "equation" && taken.press !== press) {
		const found = equationLatex(editor.session, press.hit.pos)

		// An equation pressed takes the popover from Insert / Edit equation's form.
		const closing = asked.form === null ? null : (asked.request?.nonce ?? null)

		setTaken(previous => ({ ...previous, press, closed: closing }))

		if (found !== null) {
			open({
				mode: changeable ? "edit" : "view",
				...at(pressPoint(props, press)),
				initial: found.latex,
				lossy: found.lossy,
				display: found.display,
				pos: press.hit.pos
			})
		}
	}

	// An equation selected where it cannot change shows its LaTeX; it goes when the selection leaves it.
	if (equation !== taken.equation) {
		setTaken(previous => ({ ...previous, equation }))

		if (equation !== null && !editable && opened === null) {
			open({
				mode: "view",
				...at(selectionPoint(props)),
				initial: equation.latex,
				lossy: equation.lossy,
				display: equation.display,
				pos: equation.pos
			})
		} else if (equation === null && own?.opened.mode === "view") {
			setOwn(null)
		}
	}

	const askedNonce = asked.request?.nonce
	const refused = asked.request !== null && asked.form === null

	useEffect(() => {
		if (taken.closed !== null) {
			onInputDone(taken.closed)
		}
	}, [taken.closed, onInputDone])

	// A request this popover cannot take (no equation selected, inserting not possible) is done at once.
	useEffect(() => {
		if (refused && askedNonce !== undefined) {
			onInputDone(askedNonce)
		}
	}, [refused, askedNonce, onInputDone])

	useEffect(() => {
		if (taken.press === null) {
			return
		}

		selectEquation(editor.session, taken.press.hit.pos)
		onPressDone()
	}, [taken.press, editor, onPressDone])

	// The preview of what is typed, once per frame however fast it is typed.
	useEffect(() => {
		if (opened === null || preview === null) {
			return
		}

		const frame = requestAnimationFrame(() => {
			const shown = latexPreview(latex, opened.mode === "insert" ? display : opened.display)
			const painted = paintedPreview(shown.tree, preview.ownerDocument)

			preview.replaceChildren(...(painted === undefined ? [] : [painted]))
			setChecked(previous =>
				previous !== null && previous.opened === opened && sameError(previous.error, shown.error)
					? previous
					: { opened, error: shown.error }
			)
		})

		return () => {
			cancelAnimationFrame(frame)
		}
	}, [opened, preview, latex, display])

	if (opened === null) {
		return null
	}

	const close = (): void => {
		if (asked.form !== null && askedNonce !== undefined) {
			onInputDone(askedNonce)
		} else {
			setOwn(null)
		}
	}
	const view = opened.mode === "view"
	const submit = (): void => {
		if (view) {
			close()

			return
		}

		const read = latexPreview(latex, opened.mode === "insert" ? display : opened.display)

		if (read.tree === null || read.error !== null) {
			setChecked({ opened, error: read.error })

			return
		}

		close()

		if (opened.mode === "insert") {
			execute({ type: "equation.insert", latex, display })
		} else if (latex !== opened.initial && selectEquation(editor.session, opened.pos)) {
			execute({ type: "equation.edit", latex })
		}
	}
	// Mod+Enter inserts, as in the comment fields; an input method's keys are its own.
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (isImeKeydown(event.nativeEvent)) return

		if (matchesCombo(event, "mod+enter", IS_MAC)) {
			event.preventDefault()
			submit()
		} else if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			close()
		}
	}
	const title =
		opened.mode === "insert" ? "previewDocxEquationInsertTitle" : view ? "previewDocxEquationViewTitle" : "previewDocxEquationEdit"

	return (
		<Popover
			open
			onOpenChange={next => {
				if (!next) {
					close()
				}
			}}
		>
			<PopoverTrigger
				aria-hidden="true"
				tabIndex={-1}
				className="pointer-events-none absolute size-px opacity-0"
				style={{ left: opened.x, top: opened.y }}
			/>
			<PopoverContent
				align="start"
				aria-label={t(title)}
				className="w-96 max-w-[calc(100vw-2rem)] gap-2 rounded-2xl p-3 text-xs"
				data-docx-equation=""
			>
				<label
					htmlFor={fieldId}
					className="font-medium"
				>
					{t("previewDocxEquationLatex")}
				</label>
				<textarea
					id={fieldId}
					value={latex}
					readOnly={view}
					autoFocus
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					rows={3}
					placeholder={view ? undefined : t("previewDocxEquationPlaceholder")}
					aria-invalid={error !== null}
					aria-describedby={error === null ? undefined : `${fieldId}-error`}
					className={FIELD_CLASS}
					onChange={event => {
						const next = event.target.value

						update(previous => ({ ...previous, latex: next }))
					}}
					onKeyDown={onKeyDown}
				/>
				<div
					ref={setPreview}
					role="img"
					aria-label={t("previewDocxEquationPreview")}
					className="flex min-h-12 items-center justify-center overflow-x-auto rounded-xl bg-white px-2 py-1.5 text-lg text-black"
				/>
				{error === null ? null : (
					<p
						id={`${fieldId}-error`}
						role="alert"
						className="text-destructive"
					>
						{errorMessage(t, error)}
					</p>
				)}
				{opened.mode === "edit" && opened.lossy ? <p className="text-muted-foreground">{t("previewDocxEquationLossy")}</p> : null}
				{opened.mode === "insert" ? (
					<div className="flex items-center gap-2">
						<Switch
							id={`${fieldId}-display`}
							checked={display}
							onCheckedChange={next => {
								update(previous => ({ ...previous, display: next }))
							}}
						/>
						<label htmlFor={`${fieldId}-display`}>{t("previewDocxEquationDisplay")}</label>
					</div>
				) : null}
				<div className="flex justify-end gap-1">
					{view ? null : (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={close}
						>
							{t("previewDocxEquationCancel")}
						</Button>
					)}
					<Button
						type="button"
						size="xs"
						disabled={!view && (error !== null || latex.trim() === "")}
						onClick={submit}
					>
						{t(
							view
								? "previewDocxEquationClose"
								: opened.mode === "insert"
									? "previewDocxEquationInsertAction"
									: "previewDocxEquationUpdateAction"
						)}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	)
}
