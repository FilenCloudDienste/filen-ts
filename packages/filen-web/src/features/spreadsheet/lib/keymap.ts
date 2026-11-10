import { normalizeCombo } from "@filen/shared/keymap"
import { SHEET_SHORTCUTS, type SheetKeyBindings, type SheetShortcut } from "@filen/office/react/sheet/keys"
import type { ActionDef, PlatformDefault } from "@/lib/keymap/registry"

// The spreadsheet editor's keyboard shortcuts, one action per entry of the grid's table (react/sheet/keys.ts, Excel's
// keys, which ships the defaults): "sheet.<shortcut>". The grid matches them on its own keydown against the combos in
// effect (sheetBindings), as the presentation editor does, so they act only where the sheet has focus. Save is the
// preview overlay's preview.save, which the grid takes too (sheetBindings), so the browser's Save Page As never opens
// over a sheet. The ribbon's commands ship without keys: a user may bind them.
export type SheetActionShortcut = Exclude<SheetShortcut, "save">

const PREFIX = "sheet."

// Each action's name in the shortcuts list (locales/en/previewSheet/shortcuts.ts).
const DESCRIPTIONS: Readonly<Record<SheetActionShortcut, ActionDef["descriptionKey"]>> = {
	undo: "preview:previewSheetShortcutUndo",
	redo: "preview:previewSheetShortcutRedo",
	fillDown: "preview:previewSheetShortcutFillDown",
	fillRight: "preview:previewSheetShortcutFillRight",
	fillUp: "preview:previewSheetShortcutFillUp",
	fillLeft: "preview:previewSheetShortcutFillLeft",
	fillSeries: "preview:previewSheetShortcutFillSeries",
	repeat: "preview:previewSheetShortcutRepeat",
	redoOrRepeat: "preview:previewSheetShortcutRedoOrRepeat",
	insertDate: "preview:previewSheetShortcutInsertDate",
	insertTime: "preview:previewSheetShortcutInsertTime",
	formulaFromAbove: "preview:previewSheetShortcutFormulaFromAbove",
	valueFromAbove: "preview:previewSheetShortcutValueFromAbove",
	showFormulas: "preview:previewSheetShortcutShowFormulas",
	insertCells: "preview:previewSheetShortcutInsertCells",
	deleteCells: "preview:previewSheetShortcutDeleteCells",
	pasteValues: "preview:previewSheetShortcutPasteValues",
	clearFormats: "preview:previewSheetShortcutClearFormats",
	clearAll: "preview:previewSheetShortcutClearAll",
	selectColumns: "preview:previewSheetShortcutSelectColumns",
	selectRows: "preview:previewSheetShortcutSelectRows",
	selectAll: "preview:previewSheetShortcutSelectAll",
	selectRegion: "preview:previewSheetShortcutSelectRegion",
	collapseSelection: "preview:previewSheetShortcutCollapseSelection",
	nextCorner: "preview:previewSheetShortcutNextCorner",
	revealActive: "preview:previewSheetShortcutRevealActive",
	screenRight: "preview:previewSheetShortcutScreenRight",
	screenLeft: "preview:previewSheetShortcutScreenLeft",
	nextSheet: "preview:previewSheetShortcutNextSheet",
	previousSheet: "preview:previewSheetShortcutPreviousSheet",
	bold: "preview:previewSheetShortcutBold",
	italic: "preview:previewSheetShortcutItalic",
	underline: "preview:previewSheetShortcutUnderline",
	strikethrough: "preview:previewSheetShortcutStrikethrough",
	fontGrow: "preview:previewSheetShortcutFontGrow",
	fontShrink: "preview:previewSheetShortcutFontShrink",
	formatGeneral: "preview:previewSheetShortcutFormatGeneral",
	formatCurrency: "preview:previewSheetShortcutFormatCurrency",
	formatPercent: "preview:previewSheetShortcutFormatPercent",
	formatScientific: "preview:previewSheetShortcutFormatScientific",
	formatDate: "preview:previewSheetShortcutFormatDate",
	formatTime: "preview:previewSheetShortcutFormatTime",
	formatNumber: "preview:previewSheetShortcutFormatNumber",
	formatCells: "preview:previewSheetShortcutFormatCells",
	borderOutline: "preview:previewSheetShortcutBorderOutline",
	borderNone: "preview:previewSheetShortcutBorderNone",
	wrap: "preview:previewSheetShortcutWrap",
	alignLeft: "preview:previewSheetShortcutAlignLeft",
	alignCenter: "preview:previewSheetShortcutAlignCenter",
	alignRight: "preview:previewSheetShortcutAlignRight",
	indentDecrease: "preview:previewSheetShortcutIndentDecrease",
	indentIncrease: "preview:previewSheetShortcutIndentIncrease",
	decimalsIncrease: "preview:previewSheetShortcutDecimalsIncrease",
	decimalsDecrease: "preview:previewSheetShortcutDecimalsDecrease",
	mergeCenter: "preview:previewSheetShortcutMergeCenter",
	unmerge: "preview:previewSheetShortcutUnmerge",
	hideRows: "preview:previewSheetShortcutHideRows",
	hideColumns: "preview:previewSheetShortcutHideColumns",
	unhideRows: "preview:previewSheetShortcutUnhideRows",
	unhideColumns: "preview:previewSheetShortcutUnhideColumns",
	autofitRows: "preview:previewSheetShortcutAutofitRows",
	autofitColumns: "preview:previewSheetShortcutAutofitColumns",
	selectObject: "preview:previewSheetShortcutSelectObject",
	nextPane: "preview:previewSheetShortcutNextPane",
	previousPane: "preview:previewSheetShortcutPreviousPane",
	contextMenu: "preview:previewSheetShortcutContextMenu",
	find: "preview:previewSheetShortcutFind",
	findNext: "preview:previewSheetShortcutFindNext",
	findPrevious: "preview:previewSheetShortcutFindPrevious",
	replace: "preview:previewSheetShortcutReplace",
	goTo: "preview:previewSheetShortcutGoTo",
	saveAs: "preview:previewSheetShortcutSaveAs",
	print: "preview:previewSheetShortcutPrint",
	exportCsv: "preview:previewSheetShortcutExportCsv",
	exportPdf: "preview:previewSheetShortcutExportPdf",
	zoomIn: "preview:previewSheetShortcutZoomIn",
	zoomOut: "preview:previewSheetShortcutZoomOut",
	zoomReset: "preview:previewSheetShortcutZoomReset",
	freezePanes: "preview:previewSheetShortcutFreezePanes",
	filter: "preview:previewSheetShortcutFilter",
	reapplyFilter: "preview:previewSheetShortcutReapplyFilter",
	clearFilters: "preview:previewSheetShortcutClearFilters",
	sortAscending: "preview:previewSheetShortcutSortAscending",
	sortDescending: "preview:previewSheetShortcutSortDescending",
	dataValidation: "preview:previewSheetShortcutDataValidation",
	openDropdown: "preview:previewSheetShortcutOpenDropdown",
	hyperlink: "preview:previewSheetShortcutHyperlink",
	note: "preview:previewSheetShortcutNote",
	toggleNote: "preview:previewSheetShortcutToggleNote",
	deleteNote: "preview:previewSheetShortcutDeleteNote",
	newComment: "preview:previewSheetShortcutNewComment",
	insertChart: "preview:previewSheetShortcutInsertChart",
	insertPicture: "preview:previewSheetShortcutInsertPicture",
	altText: "preview:previewSheetShortcutAltText",
	autoSum: "preview:previewSheetShortcutAutoSum",
	newSheet: "preview:previewSheetShortcutNewSheet",
	renameSheet: "preview:previewSheetShortcutRenameSheet",
	deleteSheet: "preview:previewSheetShortcutDeleteSheet",
	protectSheet: "preview:previewSheetShortcutProtectSheet"
}

// Control+Space is macOS's input source switch, which the desktop app refuses to bind: Select Entire Column has no
// default there.
const MAC_DESKTOP: Readonly<Partial<Record<SheetActionShortcut, string>>> = { selectColumns: "" }

function isAction(shortcut: SheetShortcut): shortcut is SheetActionShortcut {
	return shortcut !== "save"
}

function sheetAction(shortcut: SheetActionShortcut, windows: string, mac: string): ActionDef {
	const platformDefaults: PlatformDefault[] = []
	const desktop = MAC_DESKTOP[shortcut]

	if (desktop !== undefined) {
		platformDefaults.push({ on: { mac: true, desktop: true }, combo: desktop })
	}

	if (mac !== windows) {
		platformDefaults.push({ on: { mac: true }, combo: mac })
	}

	return {
		id: `${PREFIX}${shortcut}`,
		defaultCombo: windows,
		...(platformDefaults.length > 0 && { platformDefaults }),
		scope: "editor",
		section: "sheet",
		descriptionKey: DESCRIPTIONS[shortcut]
	}
}

export const SHEET_ACTIONS: readonly ActionDef[] = SHEET_SHORTCUTS.flatMap(({ action, windows, mac }) =>
	isAction(action) ? [sheetAction(action, windows, mac)] : []
)

export function sheetActionId(shortcut: SheetActionShortcut): string {
	return `${PREFIX}${shortcut}`
}

// The default save keys the grid keeps taking whatever preview.save is bound to: Mod+S over a sheet never opens the
// browser's Save Page As.
const SAVE_GUARD = "mod+s"

const sheetBindingsCache = new WeakMap<Readonly<Record<string, string>>, SheetKeyBindings>()

// The grid's bindings from every action's combo in effect (registry.ts bindingsOf, one object per record): the same
// object back while the record stays, so the grid's lookup is built once per change. Save is preview.save's keys and
// Mod+S.
export function sheetBindings(bindings: Readonly<Record<string, string>>): SheetKeyBindings {
	let sheet = sheetBindingsCache.get(bindings)

	if (sheet === undefined) {
		const out: Partial<Record<SheetShortcut, string>> = {}

		for (const { action } of SHEET_SHORTCUTS) {
			const bound: string | undefined = isAction(action) ? bindings[`${PREFIX}${action}`] : undefined

			if (bound !== undefined) {
				out[action] = bound
			}
		}

		const save: string | undefined = bindings["preview.save"]

		out.save = save === undefined || save === "" ? SAVE_GUARD : normalizeCombo(`${save},${SAVE_GUARD}`)
		sheet = out
		sheetBindingsCache.set(bindings, sheet)
	}

	return sheet
}
