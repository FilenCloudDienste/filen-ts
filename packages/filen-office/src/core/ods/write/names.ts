import { canonicalFormula, ofSheetName, openFormula } from "../formula/toOf"
import type { XlsxDefinedName } from "../../xlsx/model/types"
import { escapeAttribute } from "../../xml/index"

// Defined names as table:named-expressions holds them (ODF 1.3 Part 3 §9.4.11): a name naming a range as a
// table:named-range, any other as a table:named-expression in OpenFormula; the inverse of features.ts names(). Only
// the names an edit changed are written again (a structure edit moves the ranges they name); a name the reader did
// not carry into the model (its expression refused) keeps its element as it was.

export class NameRefused extends Error {}

// Names the writer writes with what they name instead (a print area on its table, a filter's database range).
const OWN = /^_xlnm\./i

export interface ScopeNames {
	// Elements by name (upper case), null for a name taken away.
	readonly replaced: ReadonlyMap<string, string | null>
	readonly added: readonly string[]
}

function key(name: XlsxDefinedName): string {
	return `${name.sheet ?? ""}\u0000${name.name.toUpperCase()}`
}

const AREA = /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?$/

// The element a name is written as; `base`: the sheet its relative references are relative to (its first cell).
export function nameElement(name: XlsxDefinedName, base: string): string {
	const area = AREA.exec(name.formula.trim())
	const hidden = name.hidden ? ' table:hidden="true"' : ""
	const baseCell = `$${ofSheetName(base)}.$A$1`

	if (area !== null) {
		const sheet = ofSheetName(area[1] === undefined ? (area[2] ?? "") : area[1].replaceAll("''", "'"))
		const first = area[3] ?? ""
		const second = area[4]
		const address = second === undefined ? `$${sheet}.${first}` : `$${sheet}.${first}:.${second}`

		return `<table:named-range table:name="${escapeAttribute(name.name)}" table:cell-range-address="${escapeAttribute(address)}" table:base-cell-address="${escapeAttribute(baseCell)}"${hidden}/>`
	}

	const written = openFormula(name.formula)

	if ("refused" in written) throw new NameRefused(`The name ${name.name}: ${written.refused}`)

	return `<table:named-expression table:name="${escapeAttribute(name.name)}" table:expression="${escapeAttribute(written.text)}" table:base-cell-address="${escapeAttribute(baseCell)}"${hidden}/>`
}

// Per scope (null: the workbook's, else a sheet id), what changed between the source's names and the model's.
export function namesPlan(
	current: readonly XlsxDefinedName[],
	source: readonly XlsxDefinedName[],
	sheetName: (sheet: number | null) => string
): Map<number | null, ScopeNames> {
	const before = new Map(source.filter(name => !OWN.test(name.name)).map(name => [key(name), name]))
	const now = new Map(current.filter(name => !OWN.test(name.name)).map(name => [key(name), name]))
	const plans = new Map<number | null, { replaced: Map<string, string | null>; added: string[] }>()
	const plan = (sheet: number | null): { replaced: Map<string, string | null>; added: string[] } => {
		let found = plans.get(sheet)

		if (found === undefined) plans.set(sheet, (found = { replaced: new Map(), added: [] }))

		return found
	}

	for (const [id, name] of now) {
		const old = before.get(id)

		if (old !== undefined && old.hidden === name.hidden && canonicalFormula(old.formula) === canonicalFormula(name.formula)) continue

		const element = nameElement(name, sheetName(name.sheet))

		if (old === undefined) plan(name.sheet).added.push(element)
		else plan(name.sheet).replaced.set(name.name.toUpperCase(), element)
	}

	for (const [id, name] of before) if (!now.has(id)) plan(name.sheet).replaced.set(name.name.toUpperCase(), null)

	return plans
}

// The sheet a scope's relative references are relative to: its own, the first for the workbook's.
export function scopeSheetName(document: {
	readonly workbook: { readonly sheets: readonly { readonly id: number; readonly name: string }[] }
}): (sheet: number | null) => string {
	return sheet => (document.workbook.sheets.find(entry => entry.id === sheet) ?? document.workbook.sheets[0])?.name ?? ""
}
