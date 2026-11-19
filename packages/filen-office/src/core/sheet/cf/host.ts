import type { SheetId, SheetRange } from "../protocol"
import type { SheetStore } from "../../xlsx/model/store"
import { CellKind, SLOT_BLOCK, type XlsxSheetModel } from "../../xlsx/model/types"
import { cellKeyOf } from "../../xlsx/edit/history"
import { dateSerial, isoSerial } from "../numfmt/date"
import type { XlsxDocument } from "../../xlsx/edit/document"
import type { FormulaHost } from "./formula/evaluate"
import { FormulaError, Unsupported, type FormulaRef, type Scalar } from "./formula/values"

// What a rule's formula reads from a workbook: its cells' values (a formula cell's result as the session shows it),
// its sheets by name, its defined names and today's date from the session's clock.

const DAY_MS = 86_400_000

// A model's cell value at a slot, or of a formula cell whose result the session shows without storing it.
export function slotValue(document: XlsxDocument, model: XlsxSheetModel, row: number, col: number, slot: number): Scalar {
	const store = model.store as SheetStore
	const block = store.blocks[Math.floor(slot / SLOT_BLOCK)]
	const at = slot % SLOT_BLOCK

	if (block === undefined) return null

	const kind = (block.kinds[at] ?? 0) as CellKind
	const value = block.values[at] ?? 0

	switch (kind) {
		case CellKind.NUMBER:
			return value
		case CellKind.SHARED_STRING:
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
			return document.stringOf(model, kind, value)
		case CellKind.BOOLEAN:
			return value !== 0
		case CellKind.ERROR:
			return FormulaError.of(model.store.strings.text(value))
		case CellKind.DATE: {
			const text = model.store.strings.text(value)
			const serial = isoSerial(text, document.date1904)

			return Number.isNaN(serial) ? text : serial
		}
		default: {
			if ((block.formulas?.[at] ?? -1) < 0) return null

			const shown = document.shownResults.get(model.id)?.get(cellKeyOf(row, col))

			if (shown === undefined || shown.value === null) return null
			if (shown.error) return FormulaError.of(String(shown.value))

			return shown.value
		}
	}
}

export class DocumentFormulaHost implements FormulaHost {
	private readonly document: XlsxDocument

	constructor(document: XlsxDocument) {
		this.document = document
	}

	get date1904(): boolean {
		return this.document.date1904
	}

	// A sheet that is not parsed yet cannot be read (its rules wait for it: SheetFeature.ready).
	private model(sheet: SheetId): XlsxSheetModel {
		const model = this.document.model(sheet)

		if (model === null) throw new Unsupported("a sheet not read yet")

		return model
	}

	value(sheet: SheetId, row: number, col: number): Scalar {
		const model = this.model(sheet)
		const slot = (model.store as SheetStore).locate(row, col)

		return slot < 0 ? null : slotValue(this.document, model, row, col, slot)
	}

	forEach(ref: FormulaRef, visit: (row: number, col: number, value: Scalar) => void): void {
		const model = this.model(ref.sheet)
		const range: SheetRange = ref

		;(model.store as SheetStore).forEachCell(range, (row, col, slot) => {
			const value = slotValue(this.document, model, row, col, slot)

			if (value !== null) visit(row, col, value)
		})
	}

	extent(sheet: SheetId): { readonly rows: number; readonly cols: number } {
		const store = this.model(sheet).store as SheetStore

		return { rows: store.rowExtent, cols: store.colExtent }
	}

	sheetByName(name: string): SheetId | null {
		const upper = name.toUpperCase()

		return this.document.workbook.sheets.find(entry => entry.name.toUpperCase() === upper)?.id ?? null
	}

	definedName(name: string, sheet: SheetId): string | null {
		const upper = name.toUpperCase()
		const names = this.document.workbook.definedNames

		return (
			names.find(entry => entry.sheet === sheet && entry.name.toUpperCase() === upper)?.formula ??
			names.find(entry => entry.sheet === null && entry.name.toUpperCase() === upper)?.formula ??
			null
		)
	}

	// The session's clock, in local time as Excel's TODAY() is.
	now(): number {
		const ms = this.document.settings.clock?.() ?? Date.now()
		const local = ms - new Date(ms).getTimezoneOffset() * 60_000

		return dateSerial(1970, 1, 1, this.document.date1904) + local / DAY_MS
	}

	today(): number {
		return Math.floor(this.now())
	}
}
