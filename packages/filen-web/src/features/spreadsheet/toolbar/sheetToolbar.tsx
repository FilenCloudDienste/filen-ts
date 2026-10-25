import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
	ArrowDownAZIcon,
	ArrowDownZAIcon,
	BaselineIcon,
	BoldIcon,
	CaptionsIcon,
	ChartColumnIcon,
	ClipboardPasteIcon,
	CodeIcon,
	CopyIcon,
	DecimalsArrowLeftIcon,
	DecimalsArrowRightIcon,
	EraserIcon,
	FilterIcon,
	FilterXIcon,
	ImageIcon,
	ItalicIcon,
	LinkIcon,
	ListIndentDecreaseIcon,
	ListIndentIncreaseIcon,
	ListOrderedIcon,
	ListChecksIcon,
	MessageSquarePlusIcon,
	PaintBucketIcon,
	PencilIcon,
	PercentIcon,
	Redo2Icon,
	RefreshCwIcon,
	RotateCwIcon,
	Rows3Icon,
	ScissorsIcon,
	SearchIcon,
	Settings2Icon,
	ShieldCheckIcon,
	SigmaIcon,
	SnowflakeIcon,
	SquarePenIcon,
	StickyNoteIcon,
	StrikethroughIcon,
	Trash2Icon,
	TypeIcon,
	UnderlineIcon,
	Undo2Icon,
	WrapTextIcon,
	ZoomInIcon,
	ZoomOutIcon,
	type LucideIcon
} from "lucide-react"
import type {
	SheetAxis,
	SheetBorderEdges,
	SheetCommand,
	SheetFormatChoices,
	SheetFormatPatch,
	SheetRenderStyle
} from "@filen/office/core/sheet"
import {
	cellsEditable,
	entryText,
	isMacPlatform,
	roundedGeneral,
	type SheetGridModel,
	type SheetGridState,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { keepFocus } from "@/features/office/lib/officeControls"
import { OfficeRibbon, type RibbonGroup, type RibbonTab } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { KbdKeys } from "@/lib/keymap/kbd"
import { CHART_TYPES } from "@/features/spreadsheet/charts/chartPanel.logic"
import { requestChart } from "@/features/spreadsheet/charts/chartRequests"
import type { SheetRibbonCommands } from "@/features/spreadsheet/components/sheetExtension"
import { clearFilters, openCustomSort, quickSort, reapplyFilters, toggleFilter } from "@/features/spreadsheet/data/sortCommands"
import { clearTarget } from "@/features/spreadsheet/data/sortFilter.logic"
import { SortFilterMenu } from "@/features/spreadsheet/data/sortFilterMenu"
import { FormatCellsDialog } from "@/features/spreadsheet/dialogs/formatCells"
import { openSheetFind } from "@/features/spreadsheet/find/findState"
import { FreezeMenu } from "@/features/spreadsheet/menus/freezeMenu"
import { MergeMenu } from "@/features/spreadsheet/menus/mergeMenu"
import { selectionSpans, spanCount, unhideSpans } from "@/features/spreadsheet/menus/structure.logic"
import { requestImage } from "@/features/spreadsheet/objects/insertRequests"
import { objectsEditable } from "@/features/spreadsheet/objects/objects.logic"
import { TAB_COLORS, cssColor } from "@/features/spreadsheet/tabs/sheetTabs.logic"
import { requestSheetTab } from "@/features/spreadsheet/tabs/tabRequests"
import { HorizontalAlignMenu, VerticalAlignMenu } from "@/features/spreadsheet/toolbar/alignMenus"
import { BordersMenu, type BorderLine } from "@/features/spreadsheet/toolbar/bordersMenu"
import { SheetColorButton } from "@/features/spreadsheet/toolbar/colorButton"
import { FontPicker, SizePicker } from "@/features/spreadsheet/toolbar/fontControls"
import { setFormatCellsOpen, useFormatCellsOpen } from "@/features/spreadsheet/toolbar/formatCellsState"
import { NumberFormatMenu } from "@/features/spreadsheet/toolbar/numberFormatMenu"
import {
	COMMA_PATCH,
	ORIENTATIONS,
	PERCENT_PATCH,
	activeFormat,
	alignPatch,
	decimalsPatch,
	indentPatch,
	rotationPatch,
	sampleOf,
	sheetShortcutKeys,
	themeSwatchRows,
	valignPatch,
	zoomStep,
	type ActiveFormat
} from "@/features/spreadsheet/toolbar/toolbar.logic"
import type { PreviewKey } from "@/lib/i18n"

// The spreadsheet editor's ribbon (officeRibbon.tsx), as Excel for the web's simplified ribbon: File, Home (undo,
// clipboard, font, alignment, number, cells, editing), Insert, Data, Review, View, and the contextual Chart and Picture
// tabs while one is selected. A text file (CSV) gets the tabs it can use. Every control shows the active cell and
// applies to the selection.

interface ActiveCell {
	readonly format: ActiveFormat
	// The cell's number (its date as a serial), for the number format previews; null when it holds none.
	readonly sample: number | null
	// The point a General number shows, as its tile says ("." unless the session's locale has another).
	readonly decimal: string
}

// The active cell's format, asked of the session when the active cell or what it shows changes. The last cell's
// stays until this one's arrives, so the controls do not flicker while the arrows move on.
function useActiveCell(grid: SheetGridState, wanted: boolean): ActiveCell | undefined {
	const { model, sheet, selection, state } = grid
	const { row, col } = selection.active
	const [cell, setCell] = useState<ActiveCell | undefined>(undefined)
	const key = `${String(sheet)}:${String(row)}:${String(col)}:${String(state.version)}`

	useEffect(() => {
		if (!wanted) {
			return undefined
		}

		let live = true

		model.session.query("cell", { sheet, row, col }).then(
			detail => {
				if (!live) {
					return
				}

				const found = model.entry(sheet, row, col)
				const shown = found === null ? "" : entryText(found.tile, found.entry)
				const base: SheetRenderStyle = model.style(0)

				setCell({
					format: activeFormat(model.style(detail.style), base, detail.numFmt, shown),
					sample: sampleOf(detail.input, detail.flags, model.date1904),
					decimal: found?.tile.layers?.general?.decimal ?? "."
				})
			},
			() => {
				if (live) {
					setFormatCellsOpen(model, false)
				}
			}
		)

		return () => {
			live = false
		}
	}, [model, sheet, row, col, key, wanted])

	return wanted ? cell : undefined
}

// What the pickers offer from the workbook (its theme's colours and fonts, its own fonts): asked once.
function useFormatChoices(model: SheetGridModel, wanted: boolean): SheetFormatChoices | undefined {
	const [choices, setChoices] = useState<SheetFormatChoices | undefined>(undefined)

	useEffect(() => {
		if (!wanted) {
			return undefined
		}

		let live = true

		model.session.query("format.choices", {}).then(
			result => {
				if (live) {
					setChoices(result)
				}
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [model, wanted])

	return choices
}

const TOGGLES: readonly {
	readonly key: "bold" | "italic" | "underline" | "strike"
	readonly icon: LucideIcon
	readonly label: PreviewKey
	readonly shortcut: SheetShortcut
}[] = [
	{ key: "bold", icon: BoldIcon, label: "previewSpreadsheetBold", shortcut: "bold" },
	{ key: "italic", icon: ItalicIcon, label: "previewSpreadsheetItalic", shortcut: "italic" },
	{ key: "underline", icon: UnderlineIcon, label: "previewSpreadsheetUnderline", shortcut: "underline" },
	{ key: "strike", icon: StrikethroughIcon, label: "previewSpreadsheetStrikethrough", shortcut: "strikethrough" }
]

function togglePatch(key: (typeof TOGGLES)[number]["key"], on: boolean): SheetFormatPatch {
	return key === "underline" ? { underline: on ? null : "single" } : { [key]: !on }
}

const FILL_DIRECTIONS: readonly { readonly direction: "down" | "right" | "up" | "left"; readonly key: PreviewKey }[] = [
	{ direction: "down", key: "previewSheetFillDown" },
	{ direction: "right", key: "previewSheetFillRight" },
	{ direction: "up", key: "previewSheetFillUp" },
	{ direction: "left", key: "previewSheetFillLeft" }
]

// A button's width with its gap, a dropdown trigger's, as the browsers lay them out (ribbonFit's estimates).
const BUTTON = 30
const MENU = 44

// What the ribbon runs beyond formats and commands: the view's own (SheetBody's) and the features' (sheetExtension.ts).
export interface SheetRibbonActions {
	copy: (cut: boolean) => void
	// Values only: the clipboard's text without its formats or formulas.
	paste: (values: boolean) => void
	// A shortcut as the keyboard runs it (AutoSum, a link, a note, a new sheet).
	shortcut: (shortcut: SheetShortcut) => void
	// The insert or delete cells dialog.
	insertCells: () => void
	deleteCells: () => void
	// The selection's rows or columns fitted to their content.
	autofit: (axis: SheetAxis) => void
	commands: SheetRibbonCommands
}

export interface SheetToolbarProps {
	grid: SheetGridState
	// Nothing edits (a view-only or failed workbook, while editing waits to become possible).
	disabled: boolean
	// A workbook (a text file holds no formats).
	formats: boolean
	onFormat: (patch: SheetFormatPatch) => void
	actions: SheetRibbonActions
	// Nothing will edit the file here (a view-only file): Home and View with what reads, as Excel's view mode.
	viewOnly?: boolean
	// The File menu, first in the tab row.
	file?: ReactNode
	// Badges at the tab row's end (the password one).
	status?: ReactNode
}

// A command dropdown: items running what they say, each closing it.
interface MenuEntry {
	readonly label: string
	readonly run: () => void
	readonly disabled?: boolean | undefined
	readonly icon?: ReactNode
	readonly checked?: boolean | undefined
}

function CommandMenu({
	label,
	icon,
	text,
	disabled,
	shortcut,
	entries,
	children
}: {
	label: string
	icon: ReactNode
	text?: string | undefined
	disabled?: boolean | undefined
	shortcut?: ReactNode
	entries: readonly (MenuEntry | null)[]
	// After the entries (submenus).
	children?: ReactNode
}) {
	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={label}
				icon={icon}
				text={text}
				disabled={disabled}
				shortcut={shortcut}
			/>
			<DropdownMenuContent data-preview-surface>
				{entries.map((entry, index) =>
					entry === null ? (
						<DropdownMenuSeparator key={`separator-${String(index)}`} />
					) : entry.checked === undefined ? (
						<DropdownMenuItem
							key={entry.label}
							disabled={entry.disabled}
							onClick={entry.run}
						>
							{entry.icon}
							{entry.label}
						</DropdownMenuItem>
					) : (
						<DropdownMenuCheckboxItem
							key={entry.label}
							checked={entry.checked}
							closeOnClick
							disabled={entry.disabled}
							onCheckedChange={entry.run}
						>
							{entry.icon}
							{entry.label}
						</DropdownMenuCheckboxItem>
					)
				)}
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Format ▾'s hide and unhide, worked out only while the menu is open.
function HideItems({ grid, run }: { grid: SheetGridState; run: (command: SheetCommand) => void }) {
	const { t } = useTranslation("preview")
	const items = [
		{ axis: "rows", hide: "previewSheetHideRows", unhide: "previewSheetUnhideRows" },
		{ axis: "cols", hide: "previewSheetHideColumns", unhide: "previewSheetUnhideColumns" }
	] as const

	return (
		<>
			{items.map(item => {
				const spans = selectionSpans(grid.selection.ranges, item.axis)
				const shown = unhideSpans(spans, grid.layout, item.axis)

				return (
					<div
						key={item.axis}
						className="contents"
					>
						<DropdownMenuItem
							onClick={() => {
								run({ type: "axis.hide", sheet: grid.sheet, axis: item.axis, spans, hidden: true })
							}}
						>
							{t(item.hide, { count: spanCount(spans) })}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={shown === null}
							onClick={() => {
								if (shown !== null) {
									run({ type: "axis.hide", sheet: grid.sheet, axis: item.axis, spans: shown, hidden: false })
								}
							}}
						>
							{t(item.unhide)}
						</DropdownMenuItem>
					</div>
				)
			})}
		</>
	)
}

// What a view-only file's ribbon keeps: copying, finding, zooming and the formulas shown.
const VIEW_ONLY_GROUPS: ReadonlySet<string> = new Set(["clipboard", "editing", "zoom", "show"])

function tabsOf(t: (key: PreviewKey) => string, formats: boolean, object: SheetRibbonCommands["object"], viewOnly: boolean): RibbonTab[] {
	if (viewOnly) {
		return [
			{ id: "home", label: t("previewOfficeRibbonTabHome") },
			{ id: "view", label: t("previewOfficeRibbonTabView") }
		]
	}

	return [
		{ id: "home", label: t("previewOfficeRibbonTabHome") },
		...(formats ? [{ id: "insert", label: t("previewOfficeRibbonTabInsert") }] : []),
		{ id: "data", label: t("previewSheetRibbonTabData") },
		...(formats ? [{ id: "review", label: t("previewOfficeRibbonTabReview") }] : []),
		{ id: "view", label: t("previewOfficeRibbonTabView") },
		...(object === undefined
			? []
			: [{ id: "object", label: t(object.chart ? "previewSheetRibbonTabChart" : "previewSheetRibbonTabPicture"), contextual: true }])
	]
}

export function SheetToolbar({ grid, disabled, formats, onFormat, actions, viewOnly, file, status }: SheetToolbarProps) {
	const { t } = useTranslation("preview")
	const model: SheetGridModel = grid.model
	const [mac] = useState(isMacPlatform)
	const wanted = formats && !disabled
	const cell = useActiveCell(grid, wanted)
	const choices = useFormatChoices(model, formats)
	const [line, setLine] = useState<BorderLine>({ style: "thin", color: null, rgb: undefined })
	const [selected, setSelected] = useState("home")
	// The app's zoom over the sheet's own (null: the sheet's), as the grid draws it.
	const [zoom, setZoom] = useState<number | null>(null)
	const dialogOpen = useFormatCellsOpen(model)
	const setDialogOpen = (open: boolean): void => {
		setFormatCellsOpen(model, open)
	}

	// Ctrl+1 while the ribbon is off has no cell format to start from: the dialog does not wait to open later.
	useEffect(() => {
		if (dialogOpen && !wanted) {
			setFormatCellsOpen(model, false)
		}
	}, [model, dialogOpen, wanted])

	const theme = choices === undefined ? [] : themeSwatchRows(choices.themeColors)
	const active = cell?.format
	// A chartsheet, dialog sheet or macro sheet takes no cell command (the session refuses them): only undo and redo.
	const noCells = disabled || !cellsEditable(grid)
	const off = noCells || active === undefined
	const automatic = t("previewOfficeColorAutomatic")
	const noFill = t("previewSpreadsheetColorNone")
	const { commands } = actions
	const tabs = tabsOf(key => t(key), formats, commands.object, viewOnly === true)
	const tab = tabs.some(entry => entry.id === selected) ? selected : "home"
	const range = grid.selection.ranges[grid.selection.ranges.length - 1]
	const percent = zoom ?? (grid.layout === null ? 100 : Math.round(model.scale(grid.layout) * 100))
	const keys = (shortcut: SheetShortcut): ReactNode => {
		const shown = sheetShortcutKeys(shortcut, mac)

		return shown === null ? undefined : <KbdKeys keys={shown} />
	}
	const sheetProtected = (grid.layout?.protection ?? null) !== null
	const filtered = clearTarget(grid.layout, grid.selection.active.row, grid.selection.active.col) !== null
	const filterOn = grid.layout?.extensions?.filters?.ranges.some(entry => entry.table === null) === true

	function command(next: SheetCommand): void {
		void model.intent()
		void model.command(next)
	}

	function borders(edges: SheetBorderEdges): void {
		command({ type: "format.borders", sheet: grid.sheet, ranges: grid.selection.ranges, edges })
	}

	function decimals(delta: 1 | -1): void {
		if (active === undefined) {
			return
		}

		// A General number a narrow cell rounds starts from what it shows, as Excel's does.
		const { row, col } = grid.selection.active
		const patch = decimalsPatch(active.numFmt, roundedGeneral(model, grid.sheet, row, col) ?? active.shown, delta, cell?.decimal ?? ".")

		if (patch !== null) {
			onFormat(patch)
		}
	}

	function indent(delta: 1 | -1): void {
		const patch = active === undefined ? null : indentPatch(active, delta)

		if (patch !== null) {
			onFormat(patch)
		}
	}

	// Whole rows or columns at the selection (Insert ▸ Insert sheet rows, Delete ▸ Delete sheet columns).
	function axis(type: "axis.insert" | "axis.delete", which: SheetAxis): void {
		if (range === undefined) {
			return
		}

		const rows = which === "rows"

		command({
			type,
			sheet: grid.sheet,
			axis: which,
			at: rows ? range.startRow : range.startCol,
			count: rows ? range.endRow - range.startRow + 1 : range.endCol - range.startCol + 1
		})
	}

	function zoomTo(next: number | null): void {
		model.setZoom(next)
		setZoom(next)
	}

	function oneRange(done: boolean): void {
		if (!done) {
			toast.error(t("previewSheetSortOneRange"))
		}
	}

	const history = [
		<TooltipIconButton
			key="undo"
			label={t("previewSpreadsheetUndo")}
			disabled={disabled || !grid.state.canUndo}
			shortcut={<KbdKeys keys={[mac ? "⌘" : "Ctrl", "Z"]} />}
			onMouseDown={keepFocus}
			onClick={() => {
				void model.undo()
			}}
		>
			<Undo2Icon />
		</TooltipIconButton>,
		<TooltipIconButton
			key="redo"
			label={t("previewSpreadsheetRedo")}
			disabled={disabled || !grid.state.canRedo}
			shortcut={<KbdKeys keys={[mac ? "⌘" : "Ctrl", "Y"]} />}
			onMouseDown={keepFocus}
			onClick={() => {
				void model.redo()
			}}
		>
			<Redo2Icon />
		</TooltipIconButton>
	]
	const clipboard = (
		<>
			<CommandMenu
				label={t("previewSheetTouchPaste")}
				icon={<ClipboardPasteIcon />}
				disabled={noCells}
				shortcut={<KbdKeys keys={[mac ? "⌘" : "Ctrl", "V"]} />}
				entries={[
					{
						label: t("previewSheetTouchPaste"),
						run: () => {
							actions.paste(false)
						}
					},
					{
						label: t("previewSheetRibbonPasteValues"),
						run: () => {
							actions.paste(true)
						}
					}
				]}
			/>
			<TooltipIconButton
				label={t("previewSheetTouchCut")}
				disabled={noCells}
				shortcut={<KbdKeys keys={[mac ? "⌘" : "Ctrl", "X"]} />}
				onMouseDown={keepFocus}
				onClick={() => {
					actions.copy(true)
				}}
			>
				<ScissorsIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewSheetTouchCopy")}
				disabled={!cellsEditable(grid)}
				shortcut={<KbdKeys keys={[mac ? "⌘" : "Ctrl", "C"]} />}
				onMouseDown={keepFocus}
				onClick={() => {
					actions.copy(false)
				}}
			>
				<CopyIcon />
			</TooltipIconButton>
		</>
	)
	const find = (
		<CommandMenu
			label={t("previewSheetRibbonFind")}
			icon={<SearchIcon />}
			shortcut={keys("find")}
			entries={[
				{
					label: t("previewSheetRibbonFind"),
					run: () => {
						openSheetFind(model, "find")
					}
				},
				{
					label: t("previewSheetRibbonReplace"),
					disabled: disabled,
					run: () => {
						openSheetFind(model, "replace")
					}
				}
			]}
		/>
	)
	const zoomGroup: RibbonGroup = {
		id: "zoom",
		label: t("previewOfficeRibbonZoom"),
		icon: ZoomInIcon,
		width: 3 * BUTTON,
		priority: 3,
		content: (
			<>
				<RibbonButton
					label={t("previewSheetRibbonZoomOut")}
					icon={<ZoomOutIcon />}
					disabled={percent <= 25}
					onClick={() => {
						zoomTo(zoomStep(percent, -1))
					}}
				/>
				<RibbonButton
					label={t("previewSheetRibbonZoomIn")}
					icon={<ZoomInIcon />}
					disabled={percent >= 400}
					onClick={() => {
						zoomTo(zoomStep(percent, 1))
					}}
				/>
				<RibbonButton
					label={t("previewSheetRibbonZoom100")}
					icon={<span className="text-[0.625rem] font-semibold">100</span>}
					onClick={() => {
						zoomTo(100)
					}}
				/>
			</>
		)
	}
	const groups: RibbonGroup[] = []

	switch (tab) {
		case "home":
			groups.push(
				{
					id: "history",
					label: t("previewOfficeRibbonUndo"),
					icon: Undo2Icon,
					width: 2 * BUTTON,
					priority: Infinity,
					content: history
				},
				{
					id: "clipboard",
					label: t("previewOfficeRibbonClipboard"),
					icon: ClipboardPasteIcon,
					width: MENU + 2 * BUTTON,
					priority: 3,
					content: clipboard
				}
			)

			if (formats) {
				groups.push(
					{
						id: "font",
						label: t("previewOfficeRibbonFont"),
						icon: TypeIcon,
						width: 146 + 66 + MENU + 2 * BUTTON,
						priority: 6,
						content: (
							<>
								<FontPicker
									choices={choices}
									font={active?.font ?? ""}
									disabled={off}
									onFont={font => {
										onFormat({ font })
									}}
								/>
								<SizePicker
									size={active?.size ?? 11}
									disabled={off}
									onSize={size => {
										onFormat({ size })
									}}
								/>
								<BordersMenu
									disabled={off}
									line={line}
									theme={theme}
									automaticLabel={automatic}
									onApply={borders}
									onLine={setLine}
								/>
								<SheetColorButton
									label={t("previewSpreadsheetFillColor")}
									icon={<PaintBucketIcon />}
									rgb={active?.fill}
									disabled={off}
									theme={theme}
									noneLabel={noFill}
									onPick={fill => {
										onFormat({ fill })
									}}
								/>
								<SheetColorButton
									label={t("previewSpreadsheetTextColor")}
									icon={<BaselineIcon />}
									rgb={active?.color}
									disabled={off}
									theme={theme}
									noneLabel={automatic}
									onPick={color => {
										onFormat({ color })
									}}
								/>
							</>
						)
					},
					{
						id: "formatting",
						label: t("previewOfficeRibbonFormatting"),
						icon: BoldIcon,
						width: TOGGLES.length * BUTTON,
						priority: 7,
						content: (
							<>
								{TOGGLES.map(toggle => {
									const Icon = toggle.icon
									const on = active?.[toggle.key] === true

									return (
										<TooltipIconButton
											key={toggle.key}
											label={t(toggle.label)}
											disabled={off}
											pressed={on}
											shortcut={keys(toggle.shortcut)}
											onMouseDown={keepFocus}
											onClick={() => {
												onFormat(togglePatch(toggle.key, on))
											}}
										>
											<Icon />
										</TooltipIconButton>
									)
								})}
							</>
						)
					},
					{
						id: "alignment",
						label: t("previewOfficeRibbonAlignment"),
						icon: WrapTextIcon,
						width: 4 * MENU + 3 * BUTTON,
						priority: 5,
						content: (
							<>
								<VerticalAlignMenu
									valign={active?.valign ?? "bottom"}
									disabled={off}
									onValign={valign => {
										onFormat(valignPatch(valign))
									}}
								/>
								<HorizontalAlignMenu
									align={active?.align ?? "general"}
									disabled={off}
									onAlign={align => {
										onFormat(alignPatch(align))
									}}
								/>
								<TooltipIconButton
									label={t("previewSheetFormatWrap")}
									disabled={off}
									pressed={active?.wrap === true}
									onMouseDown={keepFocus}
									onClick={() => {
										onFormat({ wrap: active?.wrap !== true })
									}}
								>
									<WrapTextIcon />
								</TooltipIconButton>
								<MergeMenu
									grid={grid}
									disabled={noCells}
								/>
								<TooltipIconButton
									label={t("previewSheetRibbonIndentDecrease")}
									disabled={off || active.indent === 0}
									onMouseDown={keepFocus}
									onClick={() => {
										indent(-1)
									}}
								>
									<ListIndentDecreaseIcon />
								</TooltipIconButton>
								<TooltipIconButton
									label={t("previewSheetRibbonIndentIncrease")}
									disabled={off}
									onMouseDown={keepFocus}
									onClick={() => {
										indent(1)
									}}
								>
									<ListIndentIncreaseIcon />
								</TooltipIconButton>
								<CommandMenu
									label={t("previewSheetRibbonOrientation")}
									icon={<RotateCwIcon />}
									disabled={off}
									entries={[
										...ORIENTATIONS.map(orientation => ({
											label: t(orientation.label),
											checked: active?.rotation === orientation.rotation,
											run: () => {
												onFormat(rotationPatch(active?.rotation ?? 0, orientation.rotation))
											}
										})),
										null,
										{
											label: t("previewSheetRibbonShrinkToFit"),
											checked: active?.shrink === true,
											run: () => {
												onFormat({ shrink: active?.shrink !== true })
											}
										}
									]}
								/>
							</>
						)
					},
					{
						id: "number",
						label: t("previewSheetRibbonNumber"),
						icon: PercentIcon,
						width: 114 + 5 * BUTTON,
						priority: 4,
						content: (
							<>
								<NumberFormatMenu
									numFmt={active?.numFmt ?? "General"}
									sample={cell?.sample ?? null}
									date1904={model.date1904}
									disabled={off}
									onFormat={numFmt => {
										onFormat({ numFmt })
									}}
									onMore={() => {
										setDialogOpen(true)
									}}
								/>
								<TooltipIconButton
									label={t("previewSheetPercentStyle")}
									disabled={off}
									onMouseDown={keepFocus}
									onClick={() => {
										onFormat(PERCENT_PATCH)
									}}
								>
									<PercentIcon />
								</TooltipIconButton>
								<TooltipIconButton
									label={t("previewSheetCommaStyle")}
									disabled={off}
									onMouseDown={keepFocus}
									onClick={() => {
										onFormat(COMMA_PATCH)
									}}
								>
									<span className="text-sm font-semibold">,</span>
								</TooltipIconButton>
								<TooltipIconButton
									label={t("previewSheetDecreaseDecimal")}
									disabled={off}
									onMouseDown={keepFocus}
									onClick={() => {
										decimals(-1)
									}}
								>
									<DecimalsArrowLeftIcon />
								</TooltipIconButton>
								<TooltipIconButton
									label={t("previewSheetIncreaseDecimal")}
									disabled={off}
									onMouseDown={keepFocus}
									onClick={() => {
										decimals(1)
									}}
								>
									<DecimalsArrowRightIcon />
								</TooltipIconButton>
								<TooltipIconButton
									label={t("previewSheetFormatCells")}
									disabled={off}
									shortcut={keys("formatCells")}
									onMouseDown={keepFocus}
									onClick={() => {
										setDialogOpen(true)
									}}
								>
									<Settings2Icon />
								</TooltipIconButton>
							</>
						)
					}
				)
			}

			groups.push({
				id: "cells",
				label: t("previewSheetRibbonCells"),
				icon: Rows3Icon,
				width: 3 * MENU,
				priority: 3,
				content: (
					<>
						<CommandMenu
							label={t("previewSheetRibbonInsert")}
							icon={<Rows3Icon />}
							disabled={noCells}
							shortcut={keys("insertCells")}
							entries={[
								{ label: t("previewSheetRibbonInsertCells"), run: actions.insertCells },
								{
									label: t("previewSheetRibbonInsertRows"),
									run: () => {
										axis("axis.insert", "rows")
									}
								},
								{
									label: t("previewSheetRibbonInsertColumns"),
									run: () => {
										axis("axis.insert", "cols")
									}
								},
								...(formats
									? [
											null,
											{
												label: t("previewSheetInsertSheet"),
												run: () => {
													actions.shortcut("newSheet")
												}
											}
										]
									: [])
							]}
						/>
						<CommandMenu
							label={t("previewSheetRibbonDelete")}
							icon={<Trash2Icon />}
							disabled={noCells}
							shortcut={keys("deleteCells")}
							entries={[
								{ label: t("previewSheetRibbonDeleteCells"), run: actions.deleteCells },
								{
									label: t("previewSheetRibbonDeleteRows"),
									run: () => {
										axis("axis.delete", "rows")
									}
								},
								{
									label: t("previewSheetRibbonDeleteColumns"),
									run: () => {
										axis("axis.delete", "cols")
									}
								},
								...(formats
									? [
											null,
											{
												label: t("previewSheetRibbonDeleteSheet"),
												run: () => {
													requestSheetTab(model, "delete")
												}
											}
										]
									: [])
							]}
						/>
						<CommandMenu
							label={t("previewSheetRibbonFormat")}
							icon={<SquarePenIcon />}
							disabled={disabled}
							entries={[
								{
									label: t("previewSheetRibbonAutofitRows"),
									disabled: !model.canResize(),
									run: () => {
										actions.autofit("rows")
									}
								},
								{
									label: t("previewSheetRibbonAutofitColumns"),
									disabled: !model.canResize(),
									run: () => {
										actions.autofit("cols")
									}
								}
							]}
						>
							{formats ? (
								<>
									<DropdownMenuSub>
										<DropdownMenuSubTrigger disabled={noCells}>
											{t("previewSheetRibbonHideUnhide")}
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											<HideItems
												grid={grid}
												run={command}
											/>
										</DropdownMenuSubContent>
									</DropdownMenuSub>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => {
											requestSheetTab(model, "rename")
										}}
									>
										{t("previewSheetRibbonRenameSheet")}
									</DropdownMenuItem>
									<DropdownMenuSub>
										<DropdownMenuSubTrigger>{t("previewSheetTabColor")}</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											{TAB_COLORS.map(color => (
												<DropdownMenuItem
													key={color.rgb}
													onClick={() => {
														command({ type: "sheet.tabColor", sheet: grid.sheet, color: color.rgb })
													}}
												>
													<span
														aria-hidden
														className="size-3.5 rounded-sm ring-1 ring-border"
														style={{ backgroundColor: cssColor(color.rgb) }}
													/>
													{t(color.key)}
												</DropdownMenuItem>
											))}
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={() => {
													command({ type: "sheet.tabColor", sheet: grid.sheet, color: null })
												}}
											>
												{t("previewSheetTabColorNone")}
											</DropdownMenuItem>
										</DropdownMenuSubContent>
									</DropdownMenuSub>
									<DropdownMenuItem
										onClick={() => {
											requestSheetTab(model, "protectSheet")
										}}
									>
										{t(sheetProtected ? "previewSheetUnprotect" : "previewSheetProtect")}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										disabled={off}
										onClick={() => {
											setDialogOpen(true)
										}}
									>
										{t("previewSheetFormatCells")}
									</DropdownMenuItem>
								</>
							) : null}
						</CommandMenu>
					</>
				)
			})
			groups.push({
				id: "editing",
				label: t("previewOfficeRibbonEditing"),
				icon: SearchIcon,
				width: (formats ? BUTTON + MENU : 0) + 3 * MENU,
				priority: 2,
				content: (
					<>
						{formats ? (
							<TooltipIconButton
								label={t("previewSheetAutoSum")}
								disabled={noCells}
								shortcut={keys("autoSum")}
								onMouseDown={keepFocus}
								onClick={() => {
									actions.shortcut("autoSum")
								}}
							>
								<SigmaIcon />
							</TooltipIconButton>
						) : null}
						{formats ? (
							<CommandMenu
								label={t("previewSheetFill")}
								icon={<ListOrderedIcon />}
								disabled={noCells}
								entries={[
									...FILL_DIRECTIONS.map(item => ({
										label: t(item.key),
										run: () => {
											command({
												type: "fill.copy",
												sheet: grid.sheet,
												ranges: grid.selection.ranges,
												direction: item.direction
											})
										}
									})),
									{
										label: t("previewSheetFillSeries"),
										disabled: commands.fillSeries === undefined,
										run: commands.fillSeries ?? (() => undefined)
									}
								]}
							/>
						) : null}
						<CommandMenu
							label={t("previewSheetRibbonClear")}
							icon={<EraserIcon />}
							disabled={noCells}
							entries={[
								...(formats
									? [
											{
												label: t("previewSheetRibbonClearAll"),
												run: () => {
													command({
														type: "cells.clear",
														sheet: grid.sheet,
														ranges: grid.selection.ranges,
														what: "all"
													})
												}
											},
											{
												label: t("previewSheetClearFormats"),
												run: () => {
													command({
														type: "cells.clear",
														sheet: grid.sheet,
														ranges: grid.selection.ranges,
														what: "formats"
													})
												}
											}
										]
									: []),
								{
									label: t("previewSpreadsheetClearCells"),
									run: () => {
										command({ type: "cells.clear", sheet: grid.sheet, ranges: grid.selection.ranges, what: "contents" })
									}
								}
							]}
						/>
						<SortFilterMenu
							grid={grid}
							disabled={noCells}
						/>
						{find}
					</>
				)
			})
			break
		case "insert":
			groups.push(
				{
					id: "charts",
					label: t("previewSheetRibbonCharts"),
					icon: ChartColumnIcon,
					width: 84,
					priority: 5,
					single: true,
					content: (
						<CommandMenu
							label={t("previewSheetChartInsertMenu")}
							icon={<ChartColumnIcon />}
							text={t("previewSheetChartInsert")}
							disabled={noCells}
							entries={CHART_TYPES.map(type => ({
								label: t(type.key),
								run: () => {
									requestChart(model, type.value)
								}
							}))}
						/>
					)
				},
				{
					id: "illustrations",
					label: t("previewOfficeRibbonIllustrations"),
					icon: ImageIcon,
					width: 96,
					priority: 4,
					single: true,
					content: (
						<CommandMenu
							label={t("previewSheetRibbonPictures")}
							icon={<ImageIcon />}
							text={t("previewSheetRibbonPictures")}
							disabled={noCells || !objectsEditable(grid.layout)}
							entries={[
								{
									label: t("previewSheetObjectImageFromFile"),
									run: () => {
										requestImage(model, "file")
									}
								},
								{
									label: t("previewSheetObjectImageFromDrive"),
									run: () => {
										requestImage(model, "drive")
									}
								}
							]}
						/>
					)
				},
				{
					id: "links",
					label: t("previewOfficeRibbonLinks"),
					icon: LinkIcon,
					width: 70,
					priority: 3,
					single: true,
					content: (
						<RibbonButton
							label={t("previewSheetInsertLink")}
							icon={<LinkIcon />}
							text={t("previewSheetRibbonLink")}
							disabled={noCells}
							shortcut={keys("hyperlink")}
							onClick={() => {
								actions.shortcut("hyperlink")
							}}
						/>
					)
				},
				{
					id: "comments",
					label: t("previewOfficeRibbonComments"),
					icon: MessageSquarePlusIcon,
					width: 210,
					priority: 2,
					content: (
						<>
							<RibbonButton
								label={t("previewSheetCommentNew")}
								icon={<MessageSquarePlusIcon />}
								text={t("previewSheetCommentNew")}
								disabled={commands.newComment === undefined}
								onClick={commands.newComment ?? (() => undefined)}
							/>
							<RibbonButton
								label={t("previewSheetInsertNote")}
								icon={<StickyNoteIcon />}
								text={t("previewSheetInsertNote")}
								disabled={noCells}
								shortcut={keys("note")}
								onClick={() => {
									actions.shortcut("note")
								}}
							/>
						</>
					)
				}
			)
			break
		case "data":
			groups.push({
				id: "sortFilter",
				label: t("previewSheetRibbonSortFilter"),
				icon: FilterIcon,
				width: 2 * BUTTON + 64 + (formats ? 3 * BUTTON : 0),
				priority: 4,
				content: (
					<>
						<RibbonButton
							label={t("previewSheetSortAscending")}
							icon={<ArrowDownAZIcon />}
							disabled={noCells}
							onClick={() => {
								void quickSort(model, false).then(oneRange)
							}}
						/>
						<RibbonButton
							label={t("previewSheetSortDescending")}
							icon={<ArrowDownZAIcon />}
							disabled={noCells}
							onClick={() => {
								void quickSort(model, true).then(oneRange)
							}}
						/>
						<RibbonButton
							label={t("previewSheetSortCustom")}
							icon={<ArrowDownAZIcon />}
							text={t("previewSheetRibbonCustomSort")}
							disabled={noCells}
							onClick={() => {
								void openCustomSort(model).then(oneRange)
							}}
						/>
						{formats ? (
							<>
								<RibbonButton
									label={t("previewSheetFilter")}
									icon={<FilterIcon />}
									pressed={filterOn}
									disabled={noCells}
									shortcut={keys("filter")}
									onClick={() => {
										void toggleFilter(model).then(oneRange)
									}}
								/>
								<RibbonButton
									label={t("previewSheetFilterClearAll")}
									icon={<FilterXIcon />}
									disabled={noCells || !filtered}
									onClick={() => {
										clearFilters(model)
									}}
								/>
								<RibbonButton
									label={t("previewSheetFilterReapply")}
									icon={<RefreshCwIcon />}
									disabled={noCells || !filtered}
									onClick={() => {
										reapplyFilters(model)
									}}
								/>
							</>
						) : null}
					</>
				)
			})

			if (formats) {
				groups.push({
					id: "dataTools",
					label: t("previewSheetRibbonDataTools"),
					icon: ListChecksIcon,
					width: 140,
					priority: 3,
					single: true,
					content: (
						<RibbonButton
							label={t("previewSheetDataValidation")}
							icon={<ListChecksIcon />}
							text={t("previewSheetDataValidation")}
							disabled={commands.dataValidation === undefined}
							onClick={commands.dataValidation ?? (() => undefined)}
						/>
					)
				})
			}

			break
		case "review": {
			const note = commands.note

			groups.push(
				{
					id: "comments",
					label: t("previewOfficeRibbonComments"),
					icon: MessageSquarePlusIcon,
					width: 124,
					priority: 4,
					single: true,
					content: (
						<RibbonButton
							label={t("previewSheetCommentNew")}
							icon={<MessageSquarePlusIcon />}
							text={t("previewSheetCommentNew")}
							disabled={commands.newComment === undefined}
							onClick={commands.newComment ?? (() => undefined)}
						/>
					)
				},
				{
					id: "notes",
					label: t("previewSheetRibbonNotes"),
					icon: StickyNoteIcon,
					width: 110 + 2 * BUTTON,
					priority: 3,
					content: (
						<>
							<RibbonButton
								label={t(note?.exists === true ? "previewSheetNoteEdit" : "previewSheetNoteInsert")}
								icon={note?.exists === true ? <PencilIcon /> : <StickyNoteIcon />}
								text={t(note?.exists === true ? "previewSheetNoteEdit" : "previewSheetNoteInsert")}
								disabled={note === undefined}
								shortcut={keys("note")}
								onClick={() => {
									actions.shortcut("note")
								}}
							/>
							<RibbonButton
								label={t(note?.shown === true ? "previewSheetNoteHide" : "previewSheetNoteShow")}
								icon={<CaptionsIcon />}
								pressed={note?.exists === true ? note.shown : undefined}
								disabled={note?.exists !== true}
								onClick={note?.toggle ?? (() => undefined)}
							/>
							<RibbonButton
								label={t("previewSheetRibbonDeleteNote")}
								icon={<Trash2Icon />}
								disabled={note?.exists !== true}
								onClick={note?.remove ?? (() => undefined)}
							/>
						</>
					)
				},
				{
					id: "protect",
					label: t("previewSheetRibbonProtect"),
					icon: ShieldCheckIcon,
					width: 290,
					priority: 2,
					content: (
						<>
							<RibbonButton
								label={t(sheetProtected ? "previewSheetUnprotect" : "previewSheetProtect")}
								icon={<ShieldCheckIcon />}
								text={t(sheetProtected ? "previewSheetUnprotect" : "previewSheetProtect")}
								disabled={disabled}
								onClick={() => {
									requestSheetTab(model, "protectSheet")
								}}
							/>
							<RibbonButton
								label={t("previewSheetProtectWorkbook")}
								icon={<ShieldCheckIcon />}
								text={t("previewSheetProtectWorkbook")}
								disabled={disabled}
								onClick={() => {
									requestSheetTab(model, "protectWorkbook")
								}}
							/>
						</>
					)
				}
			)
			break
		}
		case "view":
			if (formats) {
				groups.push({
					id: "window",
					label: t("previewSheetRibbonWindow"),
					icon: SnowflakeIcon,
					width: MENU,
					priority: 4,
					single: true,
					content: (
						<FreezeMenu
							grid={grid}
							disabled={noCells}
						/>
					)
				})
			}

			groups.push(zoomGroup)

			if (formats) {
				groups.push({
					id: "show",
					label: t("previewOfficeRibbonShow"),
					icon: CodeIcon,
					width: 130,
					priority: 2,
					single: true,
					content: (
						<RibbonButton
							label={t("previewSheetRibbonShowFormulas")}
							icon={<CodeIcon />}
							text={t("previewSheetRibbonShowFormulas")}
							pressed={grid.showFormulas}
							shortcut={keys("showFormulas")}
							onClick={() => {
								model.setShowFormulas(!grid.showFormulas)
							}}
						/>
					)
				})
			}

			break
		case "object": {
			const object = commands.object

			if (object !== undefined) {
				groups.push({
					id: "object",
					label: t(object.chart ? "previewSheetRibbonTabChart" : "previewSheetRibbonTabPicture"),
					icon: object.chart ? ChartColumnIcon : ImageIcon,
					width: (commands.editChart === undefined ? 0 : 110) + 2 * BUTTON,
					priority: 3,
					content: (
						<>
							{commands.editChart === undefined ? null : (
								<RibbonButton
									label={t("previewSheetChartEdit")}
									icon={<ChartColumnIcon />}
									text={t("previewSheetChartEdit")}
									onClick={commands.editChart}
								/>
							)}
							<RibbonButton
								label={t("previewSheetObjectAltText")}
								icon={<CaptionsIcon />}
								disabled={object.altText === undefined}
								onClick={object.altText ?? (() => undefined)}
							/>
							<RibbonButton
								label={t("previewSheetObjectDelete")}
								icon={<Trash2Icon />}
								disabled={object.remove === undefined}
								onClick={object.remove ?? (() => undefined)}
							/>
						</>
					)
				})
			}

			break
		}
	}

	return (
		<>
			<OfficeRibbon
				label={t("previewOfficeRibbon")}
				commandsLabel={t("previewOfficeRibbonCommands")}
				tabs={tabs}
				tab={tab}
				onTab={setSelected}
				file={file}
				status={
					<>
						{status}
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										variant="ghost"
										size="xs"
										aria-label={t("previewSheetRibbonZoomReset", { percent })}
										className="w-12 shrink-0 px-0 text-muted-foreground tabular-nums max-sm:hidden"
										onMouseDown={keepFocus}
										onClick={() => {
											zoomTo(100)
										}}
									>
										{t("previewSheetRibbonZoomLevel", { percent })}
									</Button>
								}
							/>
							<TooltipContent>{t("previewSheetRibbonZoom100")}</TooltipContent>
						</Tooltip>
					</>
				}
				groups={viewOnly === true ? groups.filter(group => VIEW_ONLY_GROUPS.has(group.id)) : groups}
			/>
			{formats ? (
				<FormatCellsDialog
					open={dialogOpen && active !== undefined}
					numFmt={active?.numFmt ?? "General"}
					sample={cell?.sample ?? null}
					date1904={model.date1904}
					onOpenChange={setDialogOpen}
					onApply={numFmt => {
						onFormat({ numFmt })
					}}
				/>
			) : null}
		</>
	)
}
