import { vi } from "vitest"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { SheetEvent, SheetFileKind } from "@filen/office/core/sheet"
import { createSheetGrid, type SheetGridModel } from "@filen/office/react/sheet"
import { previewSheetStructure } from "@/locales/en/previewSheet/structure"
import type { SheetRibbonActions } from "@/features/spreadsheet/toolbar/sheetToolbar"

// Sessions on the in-thread host as the structure menus' tests use them: the grid's model, fed the session's events.

export async function workbook(sheets: readonly { name: string; rows: (string | number | null)[][] }[]): Promise<Uint8Array> {
	return await writeXlsx({ sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows })) })
}

export async function openGrid(bytes: Uint8Array, kind: SheetFileKind): Promise<SheetGridModel> {
	const host = inThreadSheetHost()
	let model: SheetGridModel | null = null
	const pending: SheetEvent[] = []
	const opened = await host.open(bytes, { kind }, event => {
		if (model === null) {
			pending.push(event)
		} else {
			model.handleEvent(event)
		}
	})

	if (opened.kind !== "opened") {
		throw new Error(`did not open: ${opened.kind}`)
	}

	const grid = createSheetGrid(opened)

	model = grid

	for (const event of pending) {
		grid.handleEvent(event)
	}

	await opened.session.intent()

	return grid
}

type StructureKey = keyof typeof previewSheetStructure

// A structure string as shown: its English text once the catalog holds it, else the key i18next falls back to.
export function label(key: StructureKey | (string & {})): RegExp {
	const base = key.replace(/_(one|other)$/, "")
	const value: string | undefined = (previewSheetStructure as Record<string, string | undefined>)[key]
	const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

	return new RegExp(`^(${value === undefined ? "" : `${escape(value)}|`}${escape(base)})$`)
}

// The ribbon's actions beyond formats and commands, each a spy (none of the features' commands offered).
export function ribbonActions(): SheetRibbonActions {
	return {
		copy: vi.fn(),
		paste: vi.fn(),
		shortcut: vi.fn(),
		insertCells: vi.fn(),
		deleteCells: vi.fn(),
		autofit: vi.fn(),
		commands: {}
	}
}
