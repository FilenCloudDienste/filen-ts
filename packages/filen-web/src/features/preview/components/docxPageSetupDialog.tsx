import type { SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import {
	DOCX_PAGE_NUMBER_FORMATS,
	type DocxEditorCommand,
	type DocxLineNumberRestart,
	type DocxOrientation,
	type DocxPageNumberFormat
} from "@filen/office/core/docx/edit"
import { currentPageSetup, type DocxCurrentPageSetup, type PagedEditor } from "@filen/office/core/docx/paged"
import {
	MARGIN_PRESETS,
	PAPER_SIZES,
	fromTwips,
	lengthUnit,
	marginsPresetOf,
	pageSetupCommand,
	pageSetupForm,
	paperOf,
	toTwips,
	turnedMargins,
	useInputForm,
	type DocxInputChannelProps,
	type DocxLengthUnit,
	type DocxPageSetupForm
} from "@/features/preview/components/docxEditor.logic"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { PreviewKey } from "@/lib/i18n"

// Word's Page Setup as one dialog (asked for with page.setup's input from the ⋯ menu): paper size (presets
// or typed), orientation, margins (presets or typed), columns 1–3, where page numbers start and how they are
// written, line numbers, and whether it applies to the caret's section or the whole document. Prefilled from
// the caret's section as edited (currentPageSetup); only what changes is sent (everything for the whole
// document). A refusal keeps the dialog open and says so.

const FORMAT_LABELS: Readonly<Record<DocxPageNumberFormat, PreviewKey>> = {
	decimal: "previewDocxNumberDecimal",
	upperRoman: "previewDocxNumberUpperRoman",
	lowerRoman: "previewDocxNumberLowerRoman",
	upperLetter: "previewDocxNumberUpperLetter",
	lowerLetter: "previewDocxNumberLowerLetter",
	numberInDash: "previewDocxNumberDash"
}

const LINE_NUMBERS: readonly { value: DocxLineNumberRestart | "none"; label: PreviewKey }[] = [
	{ value: "none", label: "previewDocxLineNumbersNone" },
	{ value: "continuous", label: "previewDocxLineNumbersContinuous" },
	{ value: "newPage", label: "previewDocxLineNumbersPage" },
	{ value: "newSection", label: "previewDocxLineNumbersSection" }
]

const NO_FORMAT = "other"
const CUSTOM = "custom"

type LengthKey = "width" | "height" | "top" | "bottom" | "left" | "right"

// Top and bottom margins may be negative (Word: the text starts there whatever the header or footer holds).
const SIGNED: ReadonlySet<LengthKey> = new Set(["top", "bottom"])

// What the dialog holds: the choices, and the lengths as typed (in `unit`).
interface Draft {
	readonly current: DocxCurrentPageSetup
	readonly lengths: Readonly<Record<LengthKey, string>>
	// The twips each field's length was shown from, while its text is still that: rounding to the unit never
	// reads as a change.
	readonly exact: Readonly<Partial<Record<LengthKey, { readonly text: string; readonly twips: number }>>>
	readonly orientation: DocxOrientation
	// "Custom" chosen for the paper or the margins: the fields are the user's even while they match a preset.
	readonly customPaper: boolean
	readonly customMargins: boolean
	readonly mirrored: boolean
	readonly columns: number
	readonly continued: boolean
	readonly start: string
	readonly format: DocxPageNumberFormat | null
	readonly lineNumbers: DocxLineNumberRestart | null
	readonly scope: "section" | "document"
	// The document refused the settings last applied.
	readonly refused: boolean
}

// The draft with `values` (twips) shown in their fields.
function withLengths(draft: Draft, values: Readonly<Partial<Record<LengthKey, number>>>, unit: DocxLengthUnit): Draft {
	const lengths = { ...draft.lengths }
	const exact = { ...draft.exact }

	for (const [key, twips] of Object.entries(values) as [LengthKey, number][]) {
		const text = String(fromTwips(twips, unit))

		lengths[key] = text
		exact[key] = { text, twips }
	}

	return { ...draft, lengths, exact }
}

function draftOf(current: DocxCurrentPageSetup, unit: DocxLengthUnit): Draft {
	const form = pageSetupForm(current)
	const empty: Draft = {
		current,
		lengths: { width: "", height: "", top: "", bottom: "", left: "", right: "" },
		exact: {},
		orientation: form.orientation,
		customPaper: false,
		customMargins: false,
		mirrored: form.mirrored,
		columns: form.columns,
		continued: form.numberStart === null,
		start: String(form.numberStart ?? 1),
		format: form.numberFormat,
		lineNumbers: form.lineNumbers,
		scope: "section",
		refused: false
	}

	// The page as it is turned.
	return withLengths(empty, { width: current.size.width, height: current.size.height, ...form.margins }, unit)
}

// A field's length in twips: as shown when its text is still that, else as typed (NaN when no number).
function lengthOf(draft: Draft, key: LengthKey, unit: DocxLengthUnit): number {
	const text = draft.lengths[key]
	const shown = draft.exact[key]

	return shown?.text === text ? shown.twips : toTwips(text, unit)
}

// The page's orientation: the typed paper's shape once its width or height is typed (Word: wider than tall is
// landscape), else the chosen one (also for a square paper or no number). Read, never stored: the margins do not
// turn with each keystroke.
function orientationOf(draft: Draft, unit: DocxLengthUnit): DocxOrientation {
	if (draft.exact.width?.text === draft.lengths.width && draft.exact.height?.text === draft.lengths.height) {
		return draft.orientation
	}

	const width = lengthOf(draft, "width", unit)
	const height = lengthOf(draft, "height", unit)

	return width > height ? "landscape" : height > width ? "portrait" : draft.orientation
}

// The draft as the dialog's choices; null while a length or the start number is no valid number.
function formOf(draft: Draft, unit: DocxLengthUnit): DocxPageSetupForm | null {
	const keys: readonly LengthKey[] = ["width", "height", "top", "bottom", "left", "right"]
	const values = keys.map(key => lengthOf(draft, key, unit))
	const start = Number(draft.start.trim())

	if (
		values.some((value, index) => Number.isNaN(value) || (value < 0 && !SIGNED.has(keys[index] ?? "width"))) ||
		(!draft.continued && !(/^\d+$/.test(draft.start.trim()) && start <= 32_767))
	) {
		return null
	}

	const [width = 0, height = 0, top = 0, bottom = 0, left = 0, right = 0] = values

	if (width < 144 || height < 144) {
		return null
	}

	return {
		width: Math.min(width, height),
		height: Math.max(width, height),
		orientation: orientationOf(draft, unit),
		margins: { top, bottom, left, right },
		mirrored: draft.mirrored,
		columns: draft.columns,
		numberStart: draft.continued ? null : start,
		numberFormat: draft.format,
		lineNumbers: draft.lineNumbers,
		scope: draft.scope
	}
}

function Length({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				inputMode="decimal"
				value={value}
				onChange={event => {
					onChange(event.target.value)
				}}
			/>
		</Field>
	)
}

export interface DocxPageSetupDialogProps extends DocxInputChannelProps {
	editor: PagedEditor
	// The host's read-only state (a save writing): nothing is applied meanwhile.
	readOnly: boolean
	// page.setup can run (the toolbar's snapshot).
	enabled: boolean
}

export function DocxPageSetupDialog({ editor, readOnly, enabled, inputRequest, onInputDone }: DocxPageSetupDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const unit = lengthUnit(navigator.language)
	const {
		request,
		form: draft,
		setForm
	} = useInputForm(
		inputRequest,
		asked => asked.type === "page.setup",
		() => draftOf(currentPageSetup(editor), unit)
	)

	if (request === null || draft === null) {
		return null
	}

	const nonce = request.nonce
	const update = (change: (draft: Draft) => Draft): void => {
		setForm(previous => ({ ...change(previous), refused: false }))
	}
	const set = (patch: Partial<Draft>): void => {
		update(previous => ({ ...previous, ...patch }))
	}
	const setLength = (key: LengthKey, text: string): void => {
		update(previous => ({ ...previous, lengths: { ...previous.lengths, [key]: text } }))
	}
	const twips = (key: LengthKey) => lengthOf(draft, key, unit)
	const orientation = orientationOf(draft, unit)
	const form = formOf(draft, unit)
	const command: DocxEditorCommand | null = form === null ? null : pageSetupCommand(draft.current, form)
	const paper = draft.customPaper ? CUSTOM : paperOf(Math.min(twips("width"), twips("height")), Math.max(twips("width"), twips("height")))
	const margins = draft.customMargins
		? CUSTOM
		: marginsPresetOf(
				{ top: twips("top"), bottom: twips("bottom"), left: twips("left"), right: twips("right") },
				draft.mirrored,
				orientation === "landscape"
			)
	const columns = [1, 2, 3, ...(draft.columns > 3 ? [draft.columns] : [])]
	const close = (): void => {
		onInputDone(nonce)
	}

	return (
		<FormDialog
			open
			pending={false}
			wide
			title={t("previewDocxPageSetup")}
			description={t("previewDocxPageSetupBody")}
			submitLabel={t("previewDocxApplyAction")}
			cancelLabel={t("common:cancel")}
			canSubmit={command !== null && !readOnly && enabled}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={(event: SubmitEvent) => {
				event.preventDefault()

				if (command === null || readOnly) {
					return
				}

				// Applied here, so a refusal (a section the save could not write so) keeps the dialog open.
				if (editor.execute(command) === true) {
					close()
				} else {
					setForm(previous => ({ ...previous, refused: true }))
				}
			}}
		>
			<FieldGroup className="grid grid-cols-2 gap-4">
				<DocxChoiceField
					label={t("previewDocxPaperSize")}
					value={paper}
					items={[
						...PAPER_SIZES.map(size => ({ value: size.id, label: t(size.label) })),
						{ value: CUSTOM, label: t("previewDocxCustom") }
					]}
					onChange={id => {
						const size = PAPER_SIZES.find(entry => entry.id === id)

						if (size === undefined) {
							set({ customPaper: true })

							return
						}

						const landscape = orientation === "landscape"

						update(previous => ({
							...withLengths(
								previous,
								{ width: landscape ? size.height : size.width, height: landscape ? size.width : size.height },
								unit
							),
							// The shape typed before stays the page's once the preset's lengths show.
							orientation,
							customPaper: false
						}))
					}}
				/>
				<DocxChoiceField
					label={t("previewDocxOrientation")}
					value={orientation}
					items={[
						{ value: "portrait", label: t("previewDocxPortrait") },
						{ value: "landscape", label: t("previewDocxLandscape") }
					]}
					onChange={chosen => {
						if (chosen === orientation) {
							return
						}

						// The page and its margins turn, as Word's dialog turns them.
						update(previous => {
							const turnedPage: Draft = {
								...previous,
								orientation: chosen,
								lengths: { ...previous.lengths, width: previous.lengths.height, height: previous.lengths.width },
								exact: {
									...previous.exact,
									...(previous.exact.height === undefined ? {} : { width: previous.exact.height }),
									...(previous.exact.width === undefined ? {} : { height: previous.exact.width })
								}
							}
							const turned = turnedMargins(
								{
									top: lengthOf(previous, "top", unit),
									bottom: lengthOf(previous, "bottom", unit),
									left: lengthOf(previous, "left", unit),
									right: lengthOf(previous, "right", unit)
								},
								chosen === "landscape"
							)

							return Object.values(turned).some(Number.isNaN) ? turnedPage : withLengths(turnedPage, turned, unit)
						})
					}}
				/>
				<Length
					id="docx-page-width"
					label={t("previewDocxPaperWidth", { unit })}
					value={draft.lengths.width}
					onChange={text => {
						setLength("width", text)
					}}
				/>
				<Length
					id="docx-page-height"
					label={t("previewDocxPaperHeight", { unit })}
					value={draft.lengths.height}
					onChange={text => {
						setLength("height", text)
					}}
				/>
				<div className="col-span-2">
					<DocxChoiceField
						label={t("previewDocxMargins")}
						value={margins}
						items={[
							...MARGIN_PRESETS.map(preset => ({ value: preset.id, label: t(preset.label) })),
							{ value: CUSTOM, label: t("previewDocxCustom") }
						]}
						onChange={id => {
							const preset = MARGIN_PRESETS.find(entry => entry.id === id)

							if (preset === undefined) {
								set({ customMargins: true })

								return
							}

							const turned = orientation === "landscape" ? turnedMargins(preset.margins, true) : preset.margins

							// Word's gallery sets mirror margins with its Mirrored preset and clears them with the others.
							update(previous => ({
								...withLengths(previous, turned, unit),
								customMargins: false,
								mirrored: preset.mirrored === true
							}))
						}}
					/>
				</div>
				{(["top", "bottom", "left", "right"] as const).map(key => (
					<Length
						key={key}
						id={`docx-margin-${key}`}
						label={t(
							key === "top"
								? "previewDocxMarginTop"
								: key === "bottom"
									? "previewDocxMarginBottom"
									: key === "left"
										? draft.mirrored
											? "previewDocxMarginInside"
											: "previewDocxMarginLeft"
										: draft.mirrored
											? "previewDocxMarginOutside"
											: "previewDocxMarginRight",
							{ unit }
						)}
						value={draft.lengths[key]}
						onChange={text => {
							setLength(key, text)
						}}
					/>
				))}
				<Field
					orientation="horizontal"
					className="col-span-2"
				>
					<Switch
						id="docx-page-mirror"
						checked={draft.mirrored}
						onCheckedChange={mirrored => {
							set({ mirrored })
						}}
					/>
					<FieldLabel htmlFor="docx-page-mirror">{t("previewDocxMirrorMargins")}</FieldLabel>
				</Field>
				<DocxChoiceField
					label={t("previewDocxColumns")}
					value={String(draft.columns)}
					items={columns.map(count => ({ value: String(count), label: String(count) }))}
					onChange={count => {
						set({ columns: Number(count) })
					}}
				/>
				<DocxChoiceField
					label={t("previewDocxLineNumbers")}
					value={draft.lineNumbers ?? "none"}
					items={LINE_NUMBERS.map(option => ({ value: option.value, label: t(option.label) }))}
					onChange={value => {
						set({ lineNumbers: value === "none" ? null : value })
					}}
				/>
				<Field
					orientation="horizontal"
					className="col-span-2"
				>
					<Switch
						id="docx-page-continue"
						checked={draft.continued}
						onCheckedChange={continued => {
							set({ continued })
						}}
					/>
					<FieldLabel htmlFor="docx-page-continue">{t("previewDocxPageNumberContinue")}</FieldLabel>
				</Field>
				<Field>
					<FieldLabel htmlFor="docx-page-start">{t("previewDocxPageNumberStart")}</FieldLabel>
					<Input
						id="docx-page-start"
						inputMode="numeric"
						disabled={draft.continued}
						value={draft.start}
						onChange={event => {
							set({ start: event.target.value })
						}}
					/>
				</Field>
				<DocxChoiceField
					label={t("previewDocxPageNumberFormat")}
					value={draft.format ?? NO_FORMAT}
					items={[
						...DOCX_PAGE_NUMBER_FORMATS.map(format => ({ value: format, label: t(FORMAT_LABELS[format]) })),
						...(draft.format === null ? [{ value: NO_FORMAT, label: t("previewDocxNumberOther") }] : [])
					]}
					onChange={format => {
						set({ format: DOCX_PAGE_NUMBER_FORMATS.find(entry => entry === format) ?? null })
					}}
				/>
				<div className="col-span-2">
					<DocxChoiceField
						label={t("previewDocxApplyTo")}
						value={draft.scope}
						items={[
							{ value: "section", label: t("previewDocxApplySection") },
							{ value: "document", label: t("previewDocxApplyDocument") }
						]}
						onChange={scope => {
							set({ scope })
						}}
					/>
				</div>
				{form === null ? <FieldError className="col-span-2">{t("previewDocxPageSetupInvalid")}</FieldError> : null}
				{draft.refused ? (
					<FieldError
						role="alert"
						className="col-span-2"
					>
						{t("previewDocxPageSetupRefused")}
					</FieldError>
				) : null}
			</FieldGroup>
		</FormDialog>
	)
}
