import { useRef, useState, type ReactNode, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Combobox } from "@base-ui/react/combobox"
import {
	AArrowDownIcon,
	AArrowUpIcon,
	BaselineIcon,
	CheckIcon,
	ChevronDownIcon,
	HighlighterIcon,
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
	single,
	type DocxInputChannelProps,
	type DocxParagraphForm,
	type DocxPainterState,
	type DocxSwatch,
	type DocxToolbarCommand,
	type DocxToolbarSlotProps
} from "@/features/preview/components/docxEditor.logic"
import { DocxChoiceField } from "@/features/preview/components/docxFields"
import { FormatPainterButton } from "@/features/office/components/formatPainterButton"
import {
	fontMatches,
	listedFont,
	parseFontSize,
	typedFont,
	type DocxFontItem
} from "@/features/preview/components/docxFormatControls.logic"
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
import { MENU_POPUP_CLASS } from "@/components/ui/menuStyles"
import { FIELD_CONTROL_CLASS } from "@/components/ui/surface"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { i18n } from "@/lib/i18n"
import { isImeKeydown } from "@/lib/ime"

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

interface ComboGroup {
	value: string
	items: readonly string[]
}

// The font box's items by group (values: what font.family takes), with their labels, and the selection's font: a font
// in the lists by name (the theme's under their role), one outside them as itself, none for several.
function fontItems(fonts: readonly DocxFontChoice[], current: DocxValuesSnapshot["font"], t: TFunction<"preview">) {
	const groups: ComboGroup[] = []
	const all: DocxFontItem[] = []
	let value: string | null = current === null || current === "mixed" ? null : current

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
			groups.push({ value: t(label), items: items.map(item => item.value) })
			all.push(...items)
		}
	}

	if (value !== null && !fonts.some(font => font.kind !== "theme" && font.name === current)) {
		value = fonts.find(font => font.kind === "theme" && font.name === current)?.family ?? value
	}

	return { groups, all, value, labels: new Map(all.map(item => [item.value, item.label])) }
}

// Where a picker gives focus back once closed (see useCommandMenuFocus).
type MenuFocus = ReturnType<typeof useCommandMenuFocus>

// Whether the list's highlight is the user's (arrow keys, pointer) or one following what is typed.
type Highlight = "user" | "auto" | null

// Word's editable Font and Font Size boxes: a list to pick from and a field to type into. What is typed applies on
// Enter or on leaving the field (`onCommit`, false when refused: the field shows the value in effect again); Escape
// drops it and gives the document the focus (the ribbon's rule). Enter takes a highlighted item instead when the user
// moved to it, or when it follows what is typed and `exact` does not take the text as it is.
function DocxComboBox({
	label,
	items,
	value,
	labelOf,
	placeholder,
	filter,
	exact,
	disabled,
	className,
	focus,
	onPick,
	onCommit
}: {
	label: string
	items: readonly string[] | readonly ComboGroup[]
	value: string | null
	labelOf: (value: string) => string
	placeholder?: string | undefined
	// Null: the list is not narrowed by what is typed.
	filter: ((value: string, query: string) => boolean) | null
	exact: (text: string) => boolean
	disabled: boolean
	className: string
	focus: MenuFocus
	onPick: (value: string) => void
	onCommit: (text: string) => boolean
}) {
	const [draft, setDraft] = useState<string | null>(null)
	const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
	// Read by the key and blur handlers, which can run before the draft's render.
	const draftRef = useRef<string | null>(null)
	const openRef = useRef(false)
	const highlightRef = useRef<Highlight>(null)
	const actionsRef = useRef<Combobox.Root.Actions | null>(null)
	const shown = value === null ? "" : labelOf(value)
	const edit = (next: string | null): void => {
		draftRef.current = next
		setDraft(next)
	}
	// Applies what is typed; false when it was refused.
	const commit = (): boolean => {
		const text = draftRef.current

		edit(null)

		return text === null || text === shown || onCommit(text)
	}

	return (
		<Combobox.Root
			items={items}
			value={value}
			inputValue={draft ?? shown}
			itemToStringLabel={labelOf}
			filter={filter}
			autoHighlight={filter !== null}
			disabled={disabled}
			actionsRef={actionsRef}
			onValueChange={next => {
				if (typeof next === "string") {
					edit(null)
					onPick(next)
				}
			}}
			onInputValueChange={(next, details) => {
				edit(details.reason === "input-change" ? next : null)
			}}
			onItemHighlighted={(item, details) => {
				highlightRef.current = item === undefined ? null : details.reason === "none" ? "auto" : "user"
			}}
			onOpenChange={open => {
				openRef.current = open

				if (!open) {
					highlightRef.current = null
				}

				focus.opened(open)
			}}
			onOpenChangeComplete={focus.settled}
		>
			{/* Not Combobox.InputGroup, a role="group" the ribbon would take for one of its groups. */}
			<div
				ref={setAnchor}
				className={cn(
					"flex h-7 shrink-0 items-center focus-within:border-ring",
					FIELD_CONTROL_CLASS,
					disabled && "cursor-not-allowed opacity-50",
					className
				)}
			>
				<Combobox.Input
					aria-label={label}
					placeholder={placeholder}
					className="h-full w-full min-w-0 bg-transparent pl-2.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
					onKeyDown={event => {
						if (isImeKeydown(event.nativeEvent)) {
							return
						}

						if (event.key === "Escape" && !openRef.current) {
							// Not the field's own clearing: the ribbon gives the document the focus.
							event.preventBaseUIHandler()
							edit(null)
						} else if (event.key === "Enter") {
							const highlight = highlightRef.current
							const text = draftRef.current

							if (openRef.current && (highlight === "user" || (highlight === "auto" && (text === null || !exact(text))))) {
								return
							}

							event.preventBaseUIHandler()
							event.preventDefault()
							actionsRef.current?.close()

							if (!commit()) {
								event.currentTarget.select()
							}
						}
					}}
					onBlur={() => {
						commit()
					}}
				/>
				<Combobox.Trigger
					aria-label={label}
					className="flex h-full shrink-0 items-center pr-1.5 pl-0.5 text-muted-foreground outline-none"
				>
					<ChevronDownIcon className="pointer-events-none size-4" />
				</Combobox.Trigger>
			</div>
			<Combobox.Portal>
				<Combobox.Positioner
					anchor={anchor}
					side="bottom"
					align="start"
					sideOffset={4}
					className="isolate z-50"
				>
					<Combobox.Popup
						data-preview-surface
						className={cn(MENU_POPUP_CLASS, "max-h-80 min-w-(--anchor-width) data-empty:hidden")}
					>
						<Combobox.List className="p-1">
							{(entry: string | ComboGroup) =>
								typeof entry === "string" ? (
									<ComboItem
										key={entry}
										value={entry}
										label={labelOf(entry)}
									/>
								) : (
									<Combobox.Group
										key={entry.value}
										items={entry.items}
										className="scroll-my-1.5"
									>
										<Combobox.GroupLabel className="px-2 py-1 text-xs text-muted-foreground">
											{entry.value}
										</Combobox.GroupLabel>
										<Combobox.Collection>
											{(item: string) => (
												<ComboItem
													key={item}
													value={item}
													label={labelOf(item)}
												/>
											)}
										</Combobox.Collection>
									</Combobox.Group>
								)
							}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	)
}

function ComboItem({ value, label }: { value: string; label: string }) {
	return (
		<Combobox.Item
			value={value}
			data-slot="combobox-item"
			className="relative flex min-h-7 w-full items-center gap-2 rounded-xl py-1.5 pr-8 pl-2 text-sm whitespace-nowrap outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50"
		>
			{label}
			<Combobox.ItemIndicator
				render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}
			>
				<CheckIcon className="pointer-events-none size-4" />
			</Combobox.ItemIndicator>
		</Combobox.Item>
	)
}

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
	const { groups, all, value, labels } = fontItems(fonts, font, t)
	const labelOf = (family: string): string => labels.get(family) ?? family

	return (
		<DocxComboBox
			label={t("previewDocxFont")}
			items={groups}
			value={value}
			labelOf={labelOf}
			placeholder={font === "mixed" ? t("previewDocxValueMixed") : undefined}
			filter={(family, query) => fontMatches(labelOf(family), query)}
			exact={text => listedFont(text, all) !== undefined}
			disabled={disabled}
			className="w-32"
			focus={focus}
			onPick={family => {
				execute({ type: "font.family", family })
			}}
			onCommit={text => {
				const family = typedFont(text, all)

				if (family === null) {
					return false
				}

				execute({ type: "font.family", family })

				return true
			}}
		/>
	)
}

// A size in points as the pickers show it (half-points).
function points(halfPoints: number): string {
	return i18n.format(halfPoints / 2, "number")
}

const SIZE_ITEMS: readonly string[] = DOCX_FONT_SIZES.map(String)

function sizeLabel(halfPoints: string): string {
	return points(Number(halfPoints))
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

	// Several sizes leave the box empty; a size outside the list is shown, not added to it.
	return (
		<DocxComboBox
			label={t("previewDocxFontSize")}
			items={SIZE_ITEMS}
			value={size === null || size === "mixed" ? null : String(size)}
			labelOf={sizeLabel}
			filter={null}
			exact={() => true}
			disabled={disabled}
			className="w-18"
			focus={focus}
			onPick={half => {
				execute({ type: "font.size", halfPoints: Number(half) })
			}}
			onCommit={text => {
				const halfPoints = parseFontSize(text)

				if (halfPoints === null) {
					return false
				}

				execute({ type: "font.size", halfPoints })

				return true
			}}
		/>
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
	if (!commands.some(command => command.info.type === "format.copy")) {
		return null
	}

	return (
		<FormatPainterButton
			state={painter}
			// Its paste writes: off while the document cannot change.
			disabled={readOnly || (painter === "off" && snapshot?.enabled["format.copy"] !== true)}
			onCopy={sticky => {
				execute({ type: "format.copy", ...(sticky ? { sticky: true } : {}) })
			}}
			onCancel={onPainterCancel}
		/>
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
