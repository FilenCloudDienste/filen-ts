import type { SheetCommand, SheetId, SheetProtectedAction, SheetRgb, SheetSummary } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import type { PreviewKey } from "@/lib/i18n"

// Excel's standard colours, in its palette's order (the theme's own colours depend on the file's theme).
export const TAB_COLORS: readonly { readonly rgb: SheetRgb; readonly key: PreviewKey }[] = [
	{ rgb: 0xc00000, key: "previewSheetColorDarkRed" },
	{ rgb: 0xff0000, key: "previewSheetColorRed" },
	{ rgb: 0xffc000, key: "previewSheetColorOrange" },
	{ rgb: 0xffff00, key: "previewSheetColorYellow" },
	{ rgb: 0x92d050, key: "previewSheetColorLightGreen" },
	{ rgb: 0x00b050, key: "previewSheetColorGreen" },
	{ rgb: 0x00b0f0, key: "previewSheetColorLightBlue" },
	{ rgb: 0x0070c0, key: "previewSheetColorBlue" },
	{ rgb: 0x002060, key: "previewSheetColorDarkBlue" },
	{ rgb: 0x7030a0, key: "previewSheetColorPurple" }
]

export function cssColor(rgb: SheetRgb): string {
	return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`
}

// The actions of Excel's "Protect Sheet" dialog, in its order.
export const PROTECT_ACTIONS: readonly { readonly action: SheetProtectedAction; readonly key: PreviewKey }[] = [
	{ action: "selectLockedCells", key: "previewSheetAllowSelectLockedCells" },
	{ action: "selectUnlockedCells", key: "previewSheetAllowSelectUnlockedCells" },
	{ action: "formatCells", key: "previewSheetAllowFormatCells" },
	{ action: "formatColumns", key: "previewSheetAllowFormatColumns" },
	{ action: "formatRows", key: "previewSheetAllowFormatRows" },
	{ action: "insertColumns", key: "previewSheetAllowInsertColumns" },
	{ action: "insertRows", key: "previewSheetAllowInsertRows" },
	{ action: "insertHyperlinks", key: "previewSheetAllowInsertHyperlinks" },
	{ action: "deleteColumns", key: "previewSheetAllowDeleteColumns" },
	{ action: "deleteRows", key: "previewSheetAllowDeleteRows" },
	{ action: "sort", key: "previewSheetAllowSort" },
	{ action: "autoFilter", key: "previewSheetAllowAutoFilter" },
	{ action: "pivotTables", key: "previewSheetAllowPivotTables" },
	{ action: "objects", key: "previewSheetAllowObjects" },
	{ action: "scenarios", key: "previewSheetAllowScenarios" }
]

// Where "Move left" ("Move right") puts a sheet: past the next visible sheet that way (hidden ones in between are
// stepped over, as their tabs are not shown). Null at the end.
export function moveTarget(sheets: readonly SheetSummary[], sheet: SheetId, direction: -1 | 1): number | null {
	const index = sheets.findIndex(entry => entry.id === sheet)

	if (index < 0) {
		return null
	}

	for (let k = index + direction; k >= 0 && k < sheets.length; k += direction) {
		if (sheets[k]?.state === "visible") {
			return k
		}
	}

	return null
}

// The visible sheet shown once `sheet` is hidden or gone: the next one, else the one before.
export function nextShown(sheets: readonly SheetSummary[], sheet: SheetId): SheetId | null {
	const index = sheets.findIndex(entry => entry.id === sheet)

	for (let k = index + 1; k < sheets.length; k++) {
		if (sheets[k]?.state === "visible") {
			return sheets[k]?.id ?? null
		}
	}

	for (let k = index - 1; k >= 0; k--) {
		if (sheets[k]?.state === "visible") {
			return sheets[k]?.id ?? null
		}
	}

	return null
}

// A sheet a command added: the one in `after` that `before` lacks.
export function addedSheet(before: readonly SheetSummary[], after: readonly SheetSummary[] | undefined): SheetId | null {
	if (after === undefined) {
		return null
	}

	const known = new Set(before.map(entry => entry.id))

	return after.find(entry => !known.has(entry.id))?.id ?? null
}

// Runs a command that adds a sheet (insert, duplicate), and shows the sheet it added. A refusal is the model's
// refusal handler's to say.
export function addSheetAndShow(model: SheetGridModel, command: SheetCommand): Promise<void> {
	const before = model.getSnapshot().sheets

	void model.intent()

	return model.command(command).then(
		result => {
			const added = result.ok ? addedSheet(before, result.change.sheets) : null

			if (added !== null) {
				model.setSheet(added)
			}
		},
		() => undefined
	)
}

// Shift+F11 (Excel's Insert Sheet): a new worksheet in front of the active one, shown. The index counts hidden sheets.
export function insertSheetBefore(model: SheetGridModel, name: string): Promise<void> {
	const { sheets, sheet } = model.getSnapshot()
	const index = sheets.findIndex(entry => entry.id === sheet)

	return addSheetAndShow(model, index < 0 ? { type: "sheet.add", name } : { type: "sheet.add", name, index })
}
