import { useState, type ReactNode, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	AArrowDownIcon,
	AArrowUpIcon,
	BaselineIcon,
	HighlighterIcon,
	PaintbrushVerticalIcon,
	SubscriptIcon,
	SuperscriptIcon,
	TypeIcon
} from "lucide-react"
import {
	DOCX_FONT_SIZES,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxFontChoice,
	type DocxLineSpacingRule,
	type DocxTextColor,
	type DocxValuesSnapshot
} from "@filen/office/core/docx/edit"
import { cn } from "@filen/shared"
import {
	CHARACTER_SPACINGS,
	keepFocus,
	useInputForm,
	HIGHLIGHT_SWATCHES,
	STANDARD_SWATCHES,
	lengthUnit,
	paragraphCommands,
	paragraphForm,
	painterAction,
	single,
	type DocxInputChannelProps,
	type DocxParagraphForm,
	type DocxPainterState,
	type DocxSwatch,
	type DocxToolbarCommand,
	type DocxToolbarSlotProps
} from "@/features/preview/components/docxEditor.logic"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { DocxColorGrid, SwatchButton } from "@/features/office/components/officeColorGrid"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { i18n } from "@/lib/i18n"

// The ribbon's Font group (font and size pickers, growing and shrinking the size, highlight and text colours, a
// formatting menu: double strikethrough, caps, character spacing, clear all) and its Formatting group (the base toggles
// with subscript and superscript); the format painter is the Clipboard group's. Every value comes from the snapshot's
// `values` (the same object while nothing changes), so typing re-renders nothing.

export interface DocxFormatControlsProps extends DocxToolbarSlotProps {
	// The document's fonts (theme, its own, common), once read.
	fonts: readonly DocxFontChoice[]
	// The theme part of the colour pickers (rows), empty without a theme.
	theme: readonly (readonly DocxSwatch[])[]
	painter: DocxPainterState
	onPainterCancel: () => void
	// Font: the pickers, the size steps, the colours and the formatting menu; style: the base toggles (`children`: bold
	// to strikethrough, clear formatting) with subscript and superscript, a group of their own that a phone keeps.
	part: "font" | "style"
	children?: ReactNode
}

// The colour picker lives in a leaf the spreadsheet toolbar shares without reaching the editor.
export { DocxColorGrid } from "@/features/office/components/officeColorGrid"

const MIXED = "\u0000mixed"

// The highlighter's colours and No color.
function HighlightGrid({ chosen, onPick }: { chosen: string | undefined; onPick: (name: string) => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex flex-col gap-2">
			<Button
				variant="ghost"
				size="sm"
				className={cn("justify-start", chosen === "none" && "bg-accent")}
				onMouseDown={keepFocus}
				onClick={() => {
					onPick("none")
				}}
			>
				{t("previewOfficeColorNone")}
			</Button>
			<div className="grid grid-cols-5 gap-1">
				{HIGHLIGHT_SWATCHES.map(swatch => (
					<SwatchButton
						key={swatch.name}
						rgb={swatch.rgb}
						label={t(swatch.label)}
						chosen={chosen === swatch.name}
						onPick={() => {
							onPick(swatch.name)
						}}
					/>
				))}
			</div>
		</div>
	)
}

function textColor(swatch: DocxSwatch | null): DocxTextColor {
	return swatch === null ? { kind: "auto" } : swatch.color
}

// A toolbar button opening a colour picker: its icon over a bar of the colour in effect.
export function DocxColorButton({
	label,
	icon,
	rgb,
	disabled,
	children
}: {
	label: string
	icon: ReactNode
	rgb: string | undefined
	disabled: boolean
	children: (close: () => void) => ReactNode
}) {
	const [open, setOpen] = useState(false)

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={label}
									disabled={disabled}
									className="shrink-0 flex-col gap-0"
									onMouseDown={keepFocus}
								>
									{icon}
									<span
										aria-hidden="true"
										className="h-0.5 w-3.5 rounded-full ring-1 ring-border"
										style={{ backgroundColor: rgb === undefined ? "transparent" : `#${rgb}` }}
									/>
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			<PopoverContent
				data-preview-surface
				className="w-auto gap-2 p-3"
			>
				{children(() => {
					setOpen(false)
				})}
			</PopoverContent>
		</Popover>
	)
}

interface FontItem {
	value: string
	label: string
}

// The font picker's items by group, the selection's font marked: a font in the lists is chosen by name (the
// theme's under their role), one outside them is added.
function fontItems(fonts: readonly DocxFontChoice[], current: DocxValuesSnapshot["font"], t: TFunction<"preview">) {
	const groups: { label: string; items: FontItem[] }[] = []
	const all: FontItem[] = []
	let value: string = current === null || current === "mixed" ? MIXED : current

	for (const [kind, label] of [
		["theme", "previewDocxFontsTheme"],
		["document", "previewDocxFontsDocument"],
		["common", "previewDocxFontsCommon"]
	] as const) {
		const items = fonts
			.filter(font => font.kind === kind)
			.map(font => ({
				value: font.family,
				label:
					font.kind === "theme"
						? t(font.role === "headings" ? "previewDocxFontHeadings" : "previewDocxFontBody", { name: font.name })
						: font.name
			}))

		if (items.length > 0) {
			groups.push({ label: t(label), items })
			all.push(...items)
		}
	}

	const known = fonts.some(font => font.kind !== "theme" && font.name === current)

	if (!known && current !== null && current !== "mixed") {
		const theme = fonts.find(font => font.kind === "theme" && font.name === current)

		if (theme !== undefined) {
			value = theme.family
		} else {
			all.push({ value: current, label: current })
		}
	}

	if (value === MIXED) {
		all.push({ value: MIXED, label: t("previewDocxValueMixed") })
	}

	return { groups, all, value, extra: all.filter(item => !groups.some(group => group.items.includes(item))) }
}

// Where a picker gives focus back once closed (see useCommandMenuFocus).
type MenuFocus = ReturnType<typeof useCommandMenuFocus>

function FontPicker({
	fonts,
	font,
	disabled,
	execute,
	focus
}: {
	fonts: readonly DocxFontChoice[]
	font: DocxValuesSnapshot["font"]
	disabled: boolean
	execute: (command: DocxEditorCommand) => void
	focus: MenuFocus
}) {
	const { t } = useTranslation("preview")
	const { groups, all, value, extra } = fontItems(fonts, font, t)

	return (
		<Select
			items={all}
			value={value}
			disabled={disabled}
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.settled}
			onValueChange={next => {
				if (typeof next === "string" && next !== MIXED) {
					execute({ type: "font.family", family: next })
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={t("previewDocxFont")}
				className="w-32 shrink-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent
				data-preview-surface
				className="max-h-80 min-w-48"
			>
				{groups.map(group => (
					<SelectGroup key={group.label}>
						<SelectLabel>{group.label}</SelectLabel>
						{group.items.map(item => (
							<SelectItem
								key={item.value}
								value={item.value}
							>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				))}
				{extra.length > 0 ? (
					<SelectGroup>
						{extra.map(item => (
							<SelectItem
								key={item.value}
								value={item.value}
							>
								{item.label}
							</SelectItem>
						))}
					</SelectGroup>
				) : null}
			</SelectContent>
		</Select>
	)
}

// A size in points as the pickers show it (half-points).
function points(halfPoints: number): string {
	return i18n.format(halfPoints / 2, "number")
}

function SizePicker({
	size,
	disabled,
	execute,
	focus
}: {
	size: DocxValuesSnapshot["size"]
	disabled: boolean
	execute: (command: DocxEditorCommand) => void
	focus: MenuFocus
}) {
	const { t } = useTranslation("preview")
	const value = size === null || size === "mixed" ? MIXED : String(size)
	const sizes =
		size === null || size === "mixed" || DOCX_FONT_SIZES.includes(size)
			? DOCX_FONT_SIZES
			: [...DOCX_FONT_SIZES, size].sort((a, b) => a - b)
	const items = [
		...sizes.map(half => ({ value: String(half), label: points(half) })),
		...(value === MIXED ? [{ value: MIXED, label: "" }] : [])
	]

	return (
		<Select
			items={items}
			value={value}
			disabled={disabled}
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.settled}
			onValueChange={next => {
				if (typeof next === "string" && next !== MIXED) {
					execute({ type: "font.size", halfPoints: Number(next) })
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label={t("previewDocxFontSize")}
				className="w-16 shrink-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent
				data-preview-surface
				className="max-h-80"
			>
				<SelectGroup>
					{sizes.map(half => (
						<SelectItem
							key={half}
							value={String(half)}
						>
							{points(half)}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

export function DocxFormatControls(props: DocxFormatControlsProps) {
	const { t } = useTranslation("preview")
	const { snapshot, readOnly, commands } = props
	const focus = useCommandMenuFocus()
	// Run from a menu or picker, which gives focus back to the document once closed.
	const execute = (command: DocxEditorCommand): void => {
		props.execute(command)
		focus.ran()
	}
	const values = snapshot?.values
	const has = (type: DocxEditorCommandType): DocxToolbarCommand | undefined => commands.find(command => command.info.type === type)
	const off = (type: DocxEditorCommandType): boolean =>
		snapshot === undefined || has(type) === undefined || (readOnly && has(type)?.info.write === true) || !snapshot.enabled[type]
	// The formatting menu's toggles; subscript and superscript are buttons of the row.
	const toggles: readonly { type: DocxEditorCommandType; on: boolean }[] = [
		{ type: "format.doubleStrike", on: values?.doubleStrike === "on" },
		{ type: "format.smallCaps", on: values?.smallCaps === "on" },
		{ type: "format.allCaps", on: values?.allCaps === "on" }
	]
	const scripts: readonly { type: DocxEditorCommandType; on: boolean; icon: ReactNode }[] = [
		{ type: "format.subscript", on: values?.vertAlign === "subscript", icon: <SubscriptIcon /> },
		{ type: "format.superscript", on: values?.vertAlign === "superscript", icon: <SuperscriptIcon /> }
	]
	const steps: readonly { type: "font.grow" | "font.shrink"; icon: ReactNode }[] = [
		{ type: "font.grow", icon: <AArrowUpIcon /> },
		{ type: "font.shrink", icon: <AArrowDownIcon /> }
	]
	const chosenColor = values === undefined ? undefined : single(values.color)
	const chosenHighlight = values === undefined ? undefined : single(values.highlight)
	const colorRgb = values === undefined ? undefined : single(values.colorRgb)
	const highlightRgb =
		chosenHighlight === undefined || chosenHighlight === "none"
			? undefined
			: HIGHLIGHT_SWATCHES.find(swatch => swatch.name === chosenHighlight)?.rgb
	const spacing = values === undefined ? undefined : single(values.charSpacing)
	const pickColor = (swatch: DocxSwatch | null): void => {
		execute({ type: "color.text", color: textColor(swatch) })
	}
	const pickHighlight = (name: string): void => {
		const command = { type: "color.highlight", name } as DocxEditorCommand

		execute(command)
	}
	const hasMenu =
		toggles.some(toggle => has(toggle.type) !== undefined) || has("font.spacing") !== undefined || has("format.clearAll") !== undefined

	if (props.part === "style") {
		return (
			<>
				{props.children}
				{scripts.map(script => {
					const command = has(script.type)

					return command === undefined ? null : (
						<TooltipIconButton
							key={script.type}
							label={t(command.label)}
							disabled={off(script.type)}
							pressed={script.on}
							className={cn(script.on && "bg-accent text-foreground")}
							onMouseDown={keepFocus}
							onClick={() => {
								props.execute({ type: script.type } as DocxEditorCommand)
							}}
						>
							{script.icon}
						</TooltipIconButton>
					)
				})}
			</>
		)
	}

	return (
		<>
			{has("font.family") === undefined ? null : (
				<FontPicker
					fonts={props.fonts}
					font={values?.font ?? null}
					disabled={off("font.family")}
					execute={execute}
					focus={focus}
				/>
			)}
			{has("font.size") === undefined ? null : (
				<SizePicker
					size={values?.size ?? null}
					disabled={off("font.size")}
					execute={execute}
					focus={focus}
				/>
			)}
			{steps.map(step => {
				const command = has(step.type)

				return command === undefined ? null : (
					<TooltipIconButton
						key={step.type}
						label={t(command.label)}
						disabled={off(step.type)}
						onMouseDown={keepFocus}
						onClick={() => {
							props.execute({ type: step.type })
						}}
					>
						{step.icon}
					</TooltipIconButton>
				)
			})}
			{has("color.highlight") === undefined ? null : (
				<DocxColorButton
					label={t("previewDocxHighlightColor")}
					icon={<HighlighterIcon />}
					rgb={highlightRgb}
					disabled={off("color.highlight")}
				>
					{close => (
						<HighlightGrid
							chosen={chosenHighlight}
							onPick={name => {
								close()
								pickHighlight(name)
							}}
						/>
					)}
				</DocxColorButton>
			)}
			{has("color.text") === undefined ? null : (
				<DocxColorButton
					label={t("previewDocxFontColor")}
					icon={<BaselineIcon />}
					rgb={colorRgb === "auto" ? undefined : colorRgb}
					disabled={off("color.text")}
				>
					{close => (
						<DocxColorGrid
							theme={props.theme}
							standard={STANDARD_SWATCHES}
							chosen={chosenColor}
							none={{ label: t("previewOfficeColorAutomatic"), key: "auto" }}
							onPick={swatch => {
								close()
								pickColor(swatch)
							}}
						/>
					)}
				</DocxColorButton>
			)}
			{hasMenu ? (
				<DropdownMenu onOpenChange={focus.opened}>
					<Tooltip>
						<TooltipTrigger
							render={
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("previewDocxMoreFormatting")}
											disabled={snapshot === undefined}
											className="shrink-0"
											onMouseDown={keepFocus}
										>
											<TypeIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("previewDocxMoreFormatting")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent
						finalFocus={focus.finalFocus}
						data-preview-surface
					>
						{toggles.map(({ type, on }) => {
							const command = has(type)

							return command === undefined ? null : (
								<DropdownMenuCheckboxItem
									key={type}
									checked={on}
									disabled={off(type)}
									// A format applied closes the menu (Base UI keeps a checkbox item's menu open; whether focus
									// leaving it for the document closed it depended on the browser).
									closeOnClick
									onClick={() => {
										execute({ type } as DocxEditorCommand)
									}}
								>
									{t(command.label)}
								</DropdownMenuCheckboxItem>
							)
						})}
						{has("font.spacing") === undefined ? null : (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger disabled={off("font.spacing")}>
									{t("previewDocxCharacterSpacing")}
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									<DropdownMenuRadioGroup
										value={spacing === undefined ? "" : String(spacing)}
										onValueChange={(twips: string) => {
											execute({ type: "font.spacing", twips: Number(twips) })
										}}
									>
										{CHARACTER_SPACINGS.map(step => (
											<DropdownMenuRadioItem
												key={step.twips}
												value={String(step.twips)}
												closeOnClick
											>
												{t(step.label)}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						)}
						{has("format.clearAll") === undefined ? null : (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									disabled={off("format.clearAll")}
									onClick={() => {
										execute({ type: "format.clearAll" })
									}}
								>
									{t("previewDocxClearAllFormatting")}
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</>
	)
}

// The Clipboard group's format painter: a click picks up the selection's formatting for one paste, a double click
// keeps it until clicked again, a click while on puts it down.
export function DocxFormatPainter({
	commands,
	snapshot,
	readOnly,
	execute,
	painter,
	onPainterCancel
}: Pick<DocxFormatControlsProps, "commands" | "snapshot" | "readOnly" | "execute" | "painter" | "onPainterCancel">) {
	const { t } = useTranslation("preview")

	if (!commands.some(command => command.info.type === "format.copy")) {
		return null
	}

	return (
		<TooltipIconButton
			label={painter === "sticky" ? t("previewDocxFormatPainterSticky") : t("previewDocxFormatPainter")}
			pressed={painter !== "off"}
			// Its paste writes: off while the document cannot change.
			disabled={readOnly || (painter === "off" && snapshot?.enabled["format.copy"] !== true)}
			className={cn(painter !== "off" && "bg-accent text-foreground")}
			onMouseDown={keepFocus}
			onClick={event => {
				const action = painterAction(event.detail, painter)

				if (action === "cancel") {
					onPainterCancel()
				} else {
					execute({ type: "format.copy", ...(action === "sticky" ? { sticky: true } : {}) })
				}
			}}
		>
			<PaintbrushVerticalIcon />
		</TooltipIconButton>
	)
}

const LINE_RULES: readonly {
	rule: DocxLineSpacingRule
	label: "previewDocxLineSpacingMultiple" | "previewDocxLineSpacingAtLeast" | "previewDocxLineSpacingExact"
}[] = [
	{ rule: "auto", label: "previewDocxLineSpacingMultiple" },
	{ rule: "atLeast", label: "previewDocxLineSpacingAtLeast" },
	{ rule: "exact", label: "previewDocxLineSpacingExact" }
]

const SPECIALS = [
	{ value: "none", label: "previewDocxIndentNone" },
	{ value: "firstLine", label: "previewDocxIndentFirstLine" },
	{ value: "hanging", label: "previewDocxIndentHanging" }
] as const

export interface DocxParagraphDialogProps extends DocxInputChannelProps {
	values: DocxValuesSnapshot | undefined
	execute: (command: DocxEditorCommand) => void
}

// Word's Paragraph dialog (indents and spacing) for the selected paragraphs, asked for from the ⋯ menu
// (paragraph.indent's input): prefilled with their values (empty where they differ); only what is changed
// is sent.
export function DocxParagraphDialog({ values, execute, inputRequest, onInputDone }: DocxParagraphDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const unit = lengthUnit(navigator.language)
	const {
		request,
		form: opened,
		setForm
	} = useInputForm(
		inputRequest,
		asked => asked.type === "paragraph.indent",
		() => {
			if (values === undefined) {
				return null
			}

			const initial = paragraphForm(values, unit)

			return { initial, form: initial }
		}
	)
	const shown = opened !== null
	const commands = opened === null ? [] : paragraphCommands(opened.initial, opened.form, unit)
	const set = (patch: Partial<DocxParagraphForm>): void => {
		setForm(previous => ({ ...previous, form: { ...previous.form, ...patch } }))
	}
	const close = (): void => {
		if (request !== null) {
			onInputDone(request.nonce)
		}
	}
	const form = opened?.form

	return (
		<FormDialog
			open={shown}
			pending={false}
			title={t("previewDocxParagraphTitle")}
			description={t("previewDocxParagraphBody")}
			submitLabel={t("previewDocxApplyAction")}
			cancelLabel={t("common:cancel")}
			canSubmit={commands !== null && commands.length > 0}
			onOpenChange={open => {
				if (!open) {
					close()
				}
			}}
			onSubmit={(event: SubmitEvent) => {
				event.preventDefault()

				for (const command of commands ?? []) {
					execute(command)
				}

				close()
			}}
		>
			{form === undefined ? null : (
				<FieldGroup className="grid grid-cols-2 gap-4">
					<Field>
						<FieldLabel htmlFor="docx-paragraph-start">{t("previewDocxIndentStart", { unit })}</FieldLabel>
						<Input
							id="docx-paragraph-start"
							inputMode="decimal"
							value={form.start}
							onChange={event => {
								set({ start: event.target.value })
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="docx-paragraph-end">{t("previewDocxIndentEnd", { unit })}</FieldLabel>
						<Input
							id="docx-paragraph-end"
							inputMode="decimal"
							value={form.end}
							onChange={event => {
								set({ end: event.target.value })
							}}
						/>
					</Field>
					<DocxChoiceField
						label={t("previewDocxIndentSpecial")}
						value={form.special}
						items={SPECIALS.map(special => ({ value: special.value, label: t(special.label) }))}
						onChange={special => {
							set({ special })
						}}
					/>
					<Field>
						<FieldLabel htmlFor="docx-paragraph-by">{t("previewDocxIndentBy", { unit })}</FieldLabel>
						<Input
							id="docx-paragraph-by"
							inputMode="decimal"
							disabled={form.special === "none"}
							value={form.by}
							onChange={event => {
								set({ by: event.target.value })
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="docx-paragraph-before">{t("previewDocxSpaceBefore")}</FieldLabel>
						<Input
							id="docx-paragraph-before"
							inputMode="decimal"
							value={form.before}
							onChange={event => {
								set({ before: event.target.value })
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="docx-paragraph-after">{t("previewDocxSpaceAfter")}</FieldLabel>
						<Input
							id="docx-paragraph-after"
							inputMode="decimal"
							value={form.after}
							onChange={event => {
								set({ after: event.target.value })
							}}
						/>
					</Field>
					<DocxChoiceField
						label={t("previewDocxLineSpacingRule")}
						value={form.rule}
						items={LINE_RULES.map(rule => ({ value: rule.rule, label: t(rule.label) }))}
						onChange={rule => {
							set({ rule })
						}}
					/>
					<Field>
						<FieldLabel htmlFor="docx-paragraph-at">{t("previewDocxLineSpacingAt")}</FieldLabel>
						<Input
							id="docx-paragraph-at"
							inputMode="decimal"
							value={form.at}
							onChange={event => {
								set({ at: event.target.value })
							}}
						/>
					</Field>
					{commands === null ? <FieldError className="col-span-2">{t("previewDocxInvalidNumber")}</FieldError> : null}
				</FieldGroup>
			)}
		</FormDialog>
	)
}
