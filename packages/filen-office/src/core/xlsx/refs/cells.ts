import { appendAll } from "../../arrays"
import { formulaTranslator, rewriteFormula, sameSheet, type FormulaRef } from "../../sheet/refs/formulaRefs"
import type { SheetRange } from "../../sheet/protocol"
import { cellName } from "../../sheet/refs/cellRef"
import { CellKind, FormulaKind, type XlsxFormula, type XlsxFormulaTable, type XlsxSheetModel } from "../model/types"
import { axisLimit, inBand, shiftCell, shiftRange, splits, straddles, type AxisShift } from "./axis"
import { refuse, type RefConstruct } from "./catalogue"
import type { FormulaShift } from "./formulas"
import { parseRef } from "./sqref"

// Cell formulas of one sheet after a structure edit: what each formula id becomes, and the cells whose rows must
// be written again. Shared formulas (ECMA-376 Part 1 §18.3.1.40) keep their group when every member still reads
// as the master's text moved to it; members that would read differently become formulas of their own.

// A formula record changed: whole, or (the common case, kept small) only its text, as a string.
export interface FormulaChange {
	readonly id: number
	readonly before: XlsxFormula | string
	readonly after: XlsxFormula | string
}

export interface SheetFormulaPlan {
	readonly changes: readonly FormulaChange[]
	// Cells (after the edit) whose rows are written again: rows, cols.
	readonly cells: readonly number[]
}

interface Member {
	readonly row: number
	readonly col: number
	readonly id: number
}

function normal(formula: XlsxFormula, text: string): XlsxFormula {
	return { kind: FormulaKind.NORMAL, text, sharedIndex: -1, ref: null, flags: formula.flags, cellMetadata: formula.cellMetadata }
}

// A master's formula with its offset from its ref's top-left for where it now lies (none when it is that cell).
function withMasterAt(formula: XlsxFormula, at: { readonly row: number; readonly col: number }): XlsxFormula {
	const { masterOffset: _offset, ...rest } = formula
	const ref = formula.ref

	if (ref === null || (at.row === ref.startRow && at.col === ref.startCol)) return rest

	return { ...rest, masterOffset: { row: at.row - ref.startRow, col: at.col - ref.startCol } }
}

function refsOf(text: string): FormulaRef[] {
	const refs: FormulaRef[] = []

	rewriteFormula(text, ref => {
		refs.push(ref)

		return undefined
	})

	return refs
}

type Side = "before" | "after" | "split"

function side(low: number, high: number, shift: AxisShift, absolute: boolean): Side {
	if (high < shift.at) return "before"

	if (shift.type === "insert") return low >= shift.at && high + shift.count < axisLimit(shift.axis) ? "after" : "split"
	if (low >= shift.at + shift.count) return "after"

	// One position inside the deleted run moves (or goes) the same way for every member.
	return absolute && low === high ? "before" : "split"
}

export class SheetFormulas {
	private readonly sheet: XlsxSheetModel
	private readonly own: string
	private readonly formulas: FormulaShift
	// Set when the edit moves this sheet's cells.
	private readonly shift: AxisShift | null
	private readonly touch: (construct: RefConstruct) => void
	private readonly changes: FormulaChange[] = []
	private readonly cells: number[] = []

	constructor(
		sheet: XlsxSheetModel,
		own: string,
		formulas: FormulaShift,
		shift: AxisShift | null,
		touch: (construct: RefConstruct) => void
	) {
		this.sheet = sheet
		this.own = own
		this.formulas = formulas
		this.shift = shift
		this.touch = touch
	}

	plan(): SheetFormulaPlan {
		const store = this.sheet.store
		const table = store.formulas
		const groups = new Map<number, Member[]>()
		const masters = new Map<number, Member>()

		if (table.length === 0) return { changes: [], cells: [] }

		for (const block of store.blocks) {
			const ids = block.formulas

			if (ids === null) continue

			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)
				const end = block.rowStarts[i + 1] ?? 0

				for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
					const id = ids[k] ?? -1

					if (id < 0) continue

					const member = { row, col: block.cols[k] ?? 0, id }

					switch (table.kind(id)) {
						case FormulaKind.SHARED_CHILD: {
							const si = table.sharedIndex(id)
							let list = groups.get(si)

							if (list === undefined) {
								list = []
								groups.set(si, list)
							}

							list.push(member)
							break
						}
						case FormulaKind.SHARED_MASTER:
							masters.set(table.sharedIndex(id), member)
							break
						default:
							this.single(table, member)
					}
				}
			}
		}

		for (const [si, master] of masters) this.group(table, master, groups.get(si) ?? [])

		// Children whose master is gone (or never was): each keeps its text as the reader expanded it.
		for (const [si, children] of groups) {
			if (masters.has(si)) continue

			for (const child of children) {
				const expanded = table.expanded(child.id, child.row, child.col)
				const next = this.formulas.shift(expanded, this.own)

				if (next !== expanded) this.record(child, normal(table.formula(child.id), next), "formulas")
			}
		}

		return { changes: this.changes, cells: this.cells }
	}

	private moved(member: Member): { row: number; col: number } | null {
		return this.shift === null ? member : shiftCell(member.row, member.col, this.shift)
	}

	// A deleted cell's formula needs no change: nothing refers to it any more.
	private record(member: Member, after: XlsxFormula, construct: RefConstruct): void {
		const at = this.moved(member)

		if (at === null) return

		this.touch(construct)
		this.changes.push({ id: member.id, before: this.sheet.store.formulas.formula(member.id), after })
		this.cells.push(at.row, at.col)
	}

	private recordText(member: Member, before: string, after: string): void {
		const at = this.moved(member)

		if (at === null) return

		this.touch("formulas")
		this.changes.push({ id: member.id, before, after })
		this.cells.push(at.row, at.col)
	}

	private shiftedRange(range: SheetRange | null, what: string): SheetRange | null {
		if (range === null || this.shift === null) return range
		if (straddles(range, this.shift)) refuse("arrayFormula", what)
		if (!inBand(range, this.shift)) return range

		const rows = this.shift.axis === "rows"

		if (splits(rows ? range.startRow : range.startCol, rows ? range.endRow : range.endCol, this.shift)) refuse("arrayFormula", what)

		return shiftRange(range, this.shift)
	}

	// A dynamic array's range: what it spills over is calculated again after the edit (support.microsoft.com "Dynamic
	// array formulas and spilled array behavior"), so rows and columns may be inserted or deleted through it, unlike a
	// legacy array formula's. It moves with its cell, growing or shrinking where the edit runs through it; cut apart, it
	// is its cell alone until it spills again.
	private spillRange(range: SheetRange | null, at: { row: number; col: number }): SheetRange | null {
		if (range === null || this.shift === null) return range

		const shifted = inBand(range, this.shift) ? shiftRange(range, this.shift) : null

		if (shifted !== null && shifted.startRow === at.row && shifted.startCol === at.col) return shifted

		return { startRow: at.row, startCol: at.col, endRow: at.row, endCol: at.col }
	}

	private single(table: XlsxFormulaTable, member: Member): void {
		const kind = table.kind(member.id)

		// An ordinary formula: only its text can change, read without an object per formula.
		if (kind !== FormulaKind.ARRAY && kind !== FormulaKind.DATA_TABLE) {
			const before = table.text(member.id)
			const text = this.formulas.shift(before, this.own)

			if (text !== before) this.recordText(member, before, text)

			return
		}

		const formula = table.formula(member.id)
		const at = this.moved(member)

		if (at === null) return

		const text = this.formulas.shift(formula.text, this.own)
		const ref =
			formula.kind === FormulaKind.ARRAY && formula.cellMetadata >= 0
				? this.spillRange(formula.ref, at)
				: formula.kind === FormulaKind.ARRAY || formula.kind === FormulaKind.DATA_TABLE
					? this.shiftedRange(formula.ref, "array formula")
					: formula.ref
		let r1 = formula.r1
		let r2 = formula.r2

		if (formula.kind === FormulaKind.DATA_TABLE && this.shift !== null) {
			r1 = this.input(r1)
			r2 = this.input(r2)
		}

		if (text === formula.text && ref === formula.ref && r1 === formula.r1 && r2 === formula.r2) return

		if (ref === formula.ref && r1 === formula.r1 && r2 === formula.r2) this.recordText(member, formula.text, text)
		else this.record(member, { ...formula, text, ref, ...(r1 !== undefined && { r1 }), ...(r2 !== undefined && { r2 }) }, "formulas")
	}

	// A data table's input cell moved; a deleted one refuses.
	private input(text: string | undefined): string | undefined {
		if (text === undefined || this.shift === null) return text

		const range = parseRef(text)

		if (range === null) return text

		const at = shiftCell(range.startRow, range.startCol, this.shift)

		if (at === null) refuse("structureLocked", "formulas: data table input deleted")
		return at.row === range.startRow && at.col === range.startCol ? text : cellName(at.row, at.col)
	}

	private group(table: XlsxFormulaTable, master: Member, children: readonly Member[]): void {
		const formula = table.formula(master.id)
		const anchor = formula.ref

		if (anchor === null) {
			this.single(table, master)

			return
		}

		if (!this.formulas.mayChange(formula.text, this.own) && this.shift === null) return

		const uniform = this.uniform(formula.text, anchor, master, children)

		if (uniform) {
			const text = this.formulas.shift(formula.text, this.own)
			const ref = this.shift === null ? anchor : shiftRange(anchor, this.shift)
			const at = this.moved(master)

			if (at === null || ref === null) return
			if (text !== formula.text || ref !== anchor) this.record(master, withMasterAt({ ...formula, text, ref }, at), "sharedFormulas")

			return
		}

		// Each member as its own formula after the edit, then the group kept for those the master still reads as.
		const members = [master, ...children]
		const after = members.map(member => {
			const text = member === master ? formula.text : table.expanded(member.id, member.row, member.col)

			return { member, at: this.moved(member), text: this.formulas.shift(text, this.own) }
		})
		const head = after[0]

		if (head === undefined) return

		if (head.at === null) {
			for (const { member, at, text } of after.slice(1))
				if (at !== null) this.record(member, normal(table.formula(member.id), text), "sharedFormulas")

			return
		}

		const translate = formulaTranslator(head.text)
		const kept: typeof after = []
		const own: typeof after = []

		for (const entry of after.slice(1)) {
			if (entry.at === null) continue

			if (translate(entry.at.row - head.at.row, entry.at.col - head.at.col) === entry.text) kept.push(entry)
			else own.push(entry)
		}

		let range: SheetRange = { startRow: head.at.row, startCol: head.at.col, endRow: head.at.row, endCol: head.at.col }

		for (const { at } of kept) {
			if (at === null) continue

			range = {
				startRow: Math.min(range.startRow, at.row),
				startCol: Math.min(range.startCol, at.col),
				endRow: Math.max(range.endRow, at.row),
				endCol: Math.max(range.endCol, at.col)
			}
		}

		// Nothing moved and nothing reads differently: the group stays as written.
		if (
			own.length === 0 &&
			kept.length === children.length &&
			head.text === formula.text &&
			head.at.row === master.row &&
			head.at.col === master.col &&
			kept.every(entry => entry.at?.row === entry.member.row && entry.at.col === entry.member.col)
		)
			return

		if (range.startRow !== head.at.row || range.startCol !== head.at.col) {
			appendAll(own, kept)
			kept.length = 0
			range = { startRow: head.at.row, startCol: head.at.col, endRow: head.at.row, endCol: head.at.col }
		}

		for (const entry of own) this.record(entry.member, normal(table.formula(entry.member.id), entry.text), "sharedFormulas")

		this.record(
			master,
			kept.length === 0 ? normal(formula, head.text) : withMasterAt({ ...formula, text: head.text, ref: range }, head.at),
			"sharedFormulas"
		)
	}

	// Whether the edit moves every member's references alike, so the master's text moved is right for all. Cells
	// shifted in a band move members and references by where each lies: each member is read on its own.
	private uniform(text: string, anchor: SheetRange, master: Member, children: readonly Member[]): boolean {
		const shift = this.formulas.op.kind === "axis" ? this.formulas.op.shift : null

		if (shift === null) return true
		if (shift.band !== undefined) return false

		const target = this.formulas.op.kind === "axis" ? this.formulas.op.target : ""
		const rows = shift.axis === "rows"
		let low = rows ? master.row - anchor.startRow : master.col - anchor.startCol
		let high = low

		for (const child of children) {
			const offset = rows ? child.row - anchor.startRow : child.col - anchor.startCol

			low = Math.min(low, offset)
			high = Math.max(high, offset)
		}

		const base = rows ? anchor.startRow : anchor.startCol

		if (this.shift !== null && side(base + low, base + high, shift, false) === "split") return false

		for (const ref of refsOf(text)) {
			const area = ref.area

			if (ref.external || ref.lastSheet !== null || area === null) continue
			if (!(ref.sheet === null ? sameSheet(this.own, target) : sameSheet(ref.sheet, target))) continue
			if ((rows && area.kind === "cols") || (!rows && area.kind === "rows")) continue

			const parts: [number, boolean][] = rows
				? [
						[area.startRow, area.startRowAbs],
						[area.endRow, area.endRowAbs]
					]
				: [
						[area.startCol, area.startColAbs],
						[area.endCol, area.endColAbs]
					]

			for (const [value, absolute] of parts) {
				if (side(absolute ? value : value + low, absolute ? value : value + high, shift, absolute) === "split") return false
			}
		}

		return true
	}
}

// The cells of a run of rows (columns) about to be deleted that hold shared strings: the references the
// count loses.
export function sharedStringCells(sheet: XlsxSheetModel, shift: AxisShift): number {
	let count = 0
	const end = shift.at + shift.count
	const rows = shift.axis === "rows"

	for (const block of sheet.store.blocks) {
		if (rows && (block.firstRow >= end || block.firstRow + (block.rows[block.rowCount - 1] ?? 0) < shift.at)) continue

		for (let i = 0; i < block.rowCount; i++) {
			const row = block.firstRow + (block.rows[i] ?? 0)

			if (rows && (row < shift.at || row >= end)) continue

			const stop = block.rowStarts[i + 1] ?? 0

			for (let k = block.rowStarts[i] ?? 0; k < stop; k++) {
				if (block.kinds[k] !== CellKind.SHARED_STRING) continue

				const col = block.cols[k] ?? 0

				if (rows || (col >= shift.at && col < end)) count++
			}
		}
	}

	return count
}
