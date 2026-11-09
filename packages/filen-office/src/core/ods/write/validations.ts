import { minOf } from "../../arrays"
import type { SheetRange } from "../../sheet/protocol"
import type { XlsxSheetModel, XlsxWorkbookModel } from "../../xlsx/model/types"
import { parseRangeRef } from "../../xlsx/write/text"
import { decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"
import { validationRuleKey } from "../features"
import { openFormula } from "../formula/toOf"
import type { OdsTableSource } from "../source"
import { SourceAxis } from "./axis"
import { paragraphText } from "./cells"

// Validations as the writer needs them where an edit changed them: each rule's table:content-validation name (the
// source's for a rule it held, a new one's otherwise), which cell names which, the rows where that differs from the
// source, and the new rules' elements for table:content-validations (ODF 1.3 Part 3 §9.4.2).

export class ValidationRefused extends Error {}

export interface SheetValidations {
	name(row: number, col: number): string | undefined
	// Where names change along a row: its rules' first columns and the columns after their last.
	bounds(row: number): readonly number[]
	readonly rows: ReadonlySet<number>
	// Rows where the rules along a row change (each rule's first row and the row after its last), and the last row a
	// rule is on (-1 for none).
	readonly breaks: ReadonlySet<number>
	readonly lastRow: number
	// New table:content-validation elements.
	readonly fresh: readonly string[]
}

interface Rule {
	readonly key: string
	readonly attributes: ReadonlyMap<string, string>
	readonly formula1: string | null
	readonly formula2: string | null
	readonly ranges: readonly SheetRange[]
}

// The last section read and its rules: a conversion checks, writes and proves the same section in turn.
let lastRules: { readonly markup: string; readonly rules: readonly Rule[] } | null = null

function rules(markup: string): readonly Rule[] {
	if (lastRules !== null && lastRules.markup === markup) return lastRules.rules

	const read = readRules(markup)

	lastRules = { markup, rules: read }

	return read
}

function readRules(markup: string): Rule[] {
	if (markup.trim() === "") return []

	const bytes = encodeUtf8(markup)
	// Byte offsets are the text's own where it is ASCII: a rule's markup sliced, not decoded again.
	const ascii = bytes.length === markup.length
	const document: XmlDocument = parseXml(bytes)
	const root = document.documentElement()
	const out: Rule[] = []

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		if (document.localName(node) !== "dataValidation") continue

		const attributes = new Map<string, string>()

		for (const { name, value } of document.attributes(node)) attributes.set(name, value)

		let formula1: string | null = null
		let formula2: string | null = null

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (document.localName(child) === "formula1") formula1 = document.textContent(child)
			if (document.localName(child) === "formula2") formula2 = document.textContent(child)
		}

		const ranges = (attributes.get("sqref") ?? "").split(/\s+/).flatMap(text => {
			const range = parseRangeRef(text)

			return range === undefined ? [] : [range]
		})

		out.push({
			key: validationRuleKey(
				ascii
					? markup.slice(document.start(node), document.end(node))
					: decodeUtf8(bytes.subarray(document.start(node), document.end(node)))
			),
			attributes,
			formula1,
			formula2,
			ranges
		})
	}

	return out
}

const COMPARE: Readonly<Record<string, string>> = {
	equal: "=",
	notEqual: "!=",
	lessThan: "<",
	lessThanOrEqual: "<=",
	greaterThan: ">",
	greaterThanOrEqual: ">="
}

const KINDS: Readonly<Record<string, string>> = { whole: "whole-number", decimal: "decimal-number", date: "date", time: "time" }

function expression(formula: string): string {
	const written = openFormula(formula)

	if ("refused" in written) throw new ValidationRefused(`A validation's formula: ${written.refused}`)

	return written.text.replace(/^of:=/, "")
}

// The rule as table:condition (§19.618), the inverse of features.ts validationRule; undefined for any value.
function condition(rule: Rule): string | undefined {
	const type = rule.attributes.get("type") ?? "none"
	const operator = rule.attributes.get("operator") ?? "between"
	const first = rule.formula1 ?? ""
	const second = rule.formula2 ?? ""

	switch (type) {
		case "none":
			return undefined
		case "list": {
			const quoted = /^"((?:[^"]|"")*)"$/.exec(first.trim())

			if (quoted === null) return `of:cell-content-is-in-list(${expression(first)})`

			const items = (quoted[1] ?? "").replaceAll('""', '"').split(",")

			return `of:cell-content-is-in-list(${items.map(item => `"${item.replaceAll('"', '""')}"`).join(";")})`
		}
		case "custom":
			return `of:is-true-formula(${expression(first)})`
		case "textLength":
			if (operator === "between" || operator === "notBetween")
				return `of:cell-content-text-length-is-${operator === "notBetween" ? "not-" : ""}between(${expression(first)};${expression(second)})`

			return `of:cell-content-text-length()${COMPARE[operator] ?? "="}${expression(first)}`
		default: {
			const kind = KINDS[type]

			if (kind === undefined) throw new ValidationRefused(`A ${type} validation`)
			if (operator === "between" || operator === "notBetween")
				return `of:cell-content-is-${kind}() and cell-content-is-${operator === "notBetween" ? "not-" : ""}between(${expression(first)};${expression(second)})`

			return `of:cell-content-is-${kind}() and cell-content()${COMPARE[operator] ?? "="}${expression(first)}`
		}
	}
}

function message(tag: string, title: string, text: string, display: boolean, kind: string | undefined): string {
	const lines =
		text === ""
			? ""
			: text
					.split("\n")
					.map(line => `<text:p>${paragraphText(line)}</text:p>`)
					.join("")

	return `<table:${tag}${kind === undefined ? "" : ` table:message-type="${kind}"`} table:title="${escapeAttribute(title)}" table:display="${display ? "true" : "false"}">${lines}</table:${tag}>`
}

function column(index: number): string {
	let text = ""

	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return text
}

// A table:content-validation for a rule on `sheet`. Its formulas are SpreadsheetML's, written for the top-left cell of
// the rectangle around its ranges (not its first range's, which a range list need not list first): that cell is the
// base cell (§19.584).
function element(rule: Rule, name: string, sheet: string): string {
	const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`
	const base =
		rule.ranges.length === 0
			? undefined
			: `${quoted}.${column(minOf(rule.ranges.map(range => range.startCol)))}${minOf(rule.ranges.map(range => range.startRow)) + 1}`
	const test = condition(rule)
	const attributes = rule.attributes
	const list = (attributes.get("type") ?? "") === "list"

	return `<table:content-validation table:name="${escapeAttribute(name)}"${test === undefined ? "" : ` table:condition="${escapeAttribute(test)}"`} table:allow-empty-cell="${attributes.get("allowBlank") === "1" || attributes.get("allowBlank") === "true" ? "true" : "false"}"${list ? ` table:display-list="${attributes.get("showDropDown") === "1" ? "none" : "unsorted"}"` : ""}${base === undefined ? "" : ` table:base-cell-address="${escapeAttribute(base)}"`}>${message(
		"help-message",
		attributes.get("promptTitle") ?? "",
		attributes.get("prompt") ?? "",
		attributes.get("showInputMessage") === "1",
		undefined
	)}${message(
		"error-message",
		attributes.get("errorTitle") ?? "",
		attributes.get("error") ?? "",
		attributes.get("showErrorMessage") === "1",
		attributes.get("errorStyle") ?? "stop"
	)}</table:content-validation>`
}

export interface Rect {
	readonly range: SheetRange
	readonly name: string
}

// A dataValidations section as rectangles each naming its rule (by its key): what two sheets compare by.
export function validationRects(markup: string): Rect[] {
	return rules(markup).flatMap(rule => rule.ranges.map(range => ({ range, name: rule.key })))
}

// Whether two sets of rectangles name the same rule on every cell.
export function sameRects(a: readonly Rect[], b: readonly Rect[]): boolean {
	// Rows between two bounds (a rectangle's first row, the row after its last) are covered alike: one of each, the
	// rectangles covering it found by a sweep down the rows.
	const bounds = new Set<number>()

	for (const rect of [...a, ...b]) bounds.add(rect.range.startRow).add(rect.range.endRow + 1)

	const sweepA = new Sweep(a)
	const sweepB = new Sweep(b)

	for (const row of [...bounds].sort((x, y) => x - y)) if (sweepA.cells(row) !== sweepB.cells(row)) return false

	return true
}

// The rectangles covering each row, for rows asked in ascending order.
class Sweep {
	private readonly sorted: readonly Rect[]
	private next = 0
	private active: Rect[] = []

	constructor(rects: readonly Rect[]) {
		this.sorted = [...rects].sort((x, y) => x.range.startRow - y.range.startRow)
	}

	// The covered cells of `row` with the rules naming them, in one text: runs of columns alike (the names on them),
	// so rectangles cut differently over the same cells read the same, and a full-width rule costs no more than one cell.
	cells(row: number): string {
		while (this.next < this.sorted.length && (this.sorted[this.next]?.range.startRow ?? 0) <= row)
			this.active.push(this.sorted[this.next++] as Rect)

		this.active = this.active.filter(rect => rect.range.endRow >= row)

		// A sweep along the columns: the names on from each bound to the next, a run while they stay the same.
		const events = this.active
			.flatMap(rect => [
				{ at: rect.range.startCol, name: rect.name, delta: 1 },
				{ at: rect.range.endCol + 1, name: rect.name, delta: -1 }
			])
			.sort((x, y) => x.at - y.at)
		const on = new Map<string, number>()
		const runs: string[] = []
		let previous = ""
		let runStart = -1

		for (let k = 0; k < events.length;) {
			const at = events[k]?.at ?? 0

			for (; k < events.length && events[k]?.at === at; k++) {
				const event = events[k] as { at: number; name: string; delta: number }
				const count = (on.get(event.name) ?? 0) + event.delta

				if (count === 0) on.delete(event.name)
				else on.set(event.name, count)
			}

			const names = [...on]
				.map(([name, count]) => `${name}*${String(count)}`)
				.sort()
				.join(",")

			if (names === previous) continue
			if (previous !== "") runs.push(`${String(runStart)}-${String(at - 1)}:${previous}`)

			previous = names
			runStart = at
		}

		return runs.join("|")
	}
}

// The rectangles covering a row, the same between two of their bounds (a first row, the row after a last): worked out
// once per stretch by a sweep down the rows (asked in ascending order; a row above the last asked starts it again),
// held by first column for a name found by binary search.
class RowCover {
	private readonly sorted: readonly { readonly rect: Rect; readonly order: number }[]
	private next = 0
	private active: { readonly rect: Rect; readonly order: number }[] = []
	// The stretch worked out, [from, to), and its rectangles by first column.
	private from = 0
	private to = -1
	private byCol: { readonly rect: Rect; readonly order: number }[] = []
	private disjoint = true

	constructor(rects: readonly Rect[]) {
		this.sorted = rects.map((rect, order) => ({ rect, order })).sort((x, y) => x.rect.range.startRow - y.rect.range.startRow)
	}

	private settle(row: number): void {
		if (row >= this.from && row < this.to) return
		if (row < this.from) {
			this.next = 0
			this.active = []
		}

		while (this.next < this.sorted.length && (this.sorted[this.next]?.rect.range.startRow ?? 0) <= row)
			this.active.push(this.sorted[this.next++] as { rect: Rect; order: number })

		this.active = this.active.filter(item => item.rect.range.endRow >= row)

		// Until the next rectangle starts or an active one ends.
		let to = (this.sorted[this.next]?.rect.range.startRow ?? Number.MAX_SAFE_INTEGER) as number

		for (const item of this.active) to = Math.min(to, item.rect.range.endRow + 1)

		this.from = row
		this.to = to
		this.byCol = [...this.active].sort((x, y) => x.rect.range.startCol - y.rect.range.startCol)
		this.disjoint = this.byCol.every((item, k) => k === 0 || (this.byCol[k - 1]?.rect.range.endCol ?? -1) < item.rect.range.startCol)
	}

	// The first rectangle (in the rules' order) naming the cell.
	name(row: number, col: number): string | undefined {
		this.settle(row)

		if (!this.disjoint) {
			let best: { rect: Rect; order: number } | undefined

			for (const item of this.byCol)
				if (col >= item.rect.range.startCol && col <= item.rect.range.endCol && (best === undefined || item.order < best.order))
					best = item

			return best?.rect.name
		}

		let low = 0
		let high = this.byCol.length - 1
		let found = -1

		while (low <= high) {
			const middle = (low + high) >> 1

			if ((this.byCol[middle]?.rect.range.startCol ?? 0) <= col) {
				found = middle
				low = middle + 1
			} else high = middle - 1
		}

		const item = this.byCol[found]

		return item !== undefined && col <= item.rect.range.endCol ? item.rect.name : undefined
	}

	bounds(row: number): number[] {
		this.settle(row)

		return this.byCol.flatMap(item => [item.rect.range.startCol, item.rect.range.endCol + 1])
	}
}

// The next free number of each set of names in use (`taken` only grows): a name is found past the last one given,
// never by probing from 1 again.
const nextFree = new WeakMap<Set<string>, number>()

function freeName(taken: Set<string>): string {
	let n = nextFree.get(taken) ?? 1

	while (taken.has(`valF${String(n)}`)) n++

	const name = `valF${String(n)}`

	taken.add(name)
	nextFree.set(taken, n + 1)

	return name
}

// A sheet's validations where an edit changed them (its dataValidations section written), null where it did not.
// `taken`: names in use across the workbook (new ones are added to it).
export function sheetValidations(
	workbook: XlsxWorkbookModel,
	model: XlsxSheetModel,
	sheetName: string,
	table: OdsTableSource | null,
	current: string | null,
	taken: Set<string>
): SheetValidations | null {
	const steps = sheetValidationsSteps(workbook, model, sheetName, table, current, taken)

	for (;;) {
		const step = steps.next()

		if (step.done === true) return step.value
	}
}

// Rules worked through between yields.
const RULES_PER_STEP = 256

// sheetValidations as steps: it yields every RULES_PER_STEP rules, so a sliced run gives the host its turns.
export function* sheetValidationsSteps(
	workbook: XlsxWorkbookModel,
	model: XlsxSheetModel,
	sheetName: string,
	table: OdsTableSource | null,
	current: string | null,
	taken: Set<string>
): Generator<void, SheetValidations | null> {
	const axes = model as { rowAxis?: SourceAxis; colAxis?: SourceAxis }
	const rowAxis = axes.rowAxis ?? SourceAxis.identity(0)
	const colAxis = axes.colAxis ?? SourceAxis.identity(0)

	void workbook

	if (current === null && table !== null && rowAxis.identity && colAxis.identity) return null

	const now = rules(
		current ??
			model.sections
				.filter(section => section.name === "dataValidations")
				.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
				.join("")
	)
	const fresh: string[] = []
	const named: Rect[] = []

	let step = 0

	for (const rule of now) {
		if (++step % RULES_PER_STEP === 0) yield

		let name = table?.validationNames.get(rule.key)

		if (name === undefined) {
			name = freeName(taken)

			fresh.push(element(rule, name, sheetName))
		}

		for (const range of rule.ranges) named.push({ range, name })
	}

	// What the source held: its section's rules, by the names they came from, moved to where their cells are now.
	const before: Rect[] = []

	if (table !== null) {
		const source = rules(
			table.sections
				.filter(section => section.name === "dataValidations")
				.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
				.join("")
		)

		for (const rule of source) {
			if (++step % RULES_PER_STEP === 0) yield

			const name = table.validationNames.get(rule.key)

			if (name === undefined) continue

			for (const range of rule.ranges) {
				const startCol = colAxis.target(range.startCol)
				const endCol = colAxis.target(range.endCol)

				for (let row = range.startRow; row <= range.endRow; row++) {
					const target = rowAxis.target(row)

					if (target < 0 || startCol < 0 || endCol < 0) continue

					before.push({ range: { startRow: target, endRow: target, startCol, endCol }, name })
				}
			}
		}
	}

	const cover = new RowCover(named)
	const rows = new Set<number>()
	const breaks = new Set<number>()
	let lastRow = -1

	for (const rect of named) {
		breaks.add(rect.range.startRow).add(rect.range.endRow + 1)
		lastRow = Math.max(lastRow, rect.range.endRow)
	}

	// A new table's rows are all written: none differs from a source.
	if (table !== null) {
		// Between two bounds of either set the rows are covered alike: compared once per stretch, its rows taken whole.
		const edges = new Set<number>()

		for (const rect of [...named, ...before]) edges.add(rect.range.startRow).add(rect.range.endRow + 1)

		const sorted = [...edges].sort((x, y) => x - y)
		const now = new Sweep(named)
		const was = new Sweep(before)

		for (let k = 0; k + 1 < sorted.length; k++) {
			if (k % RULES_PER_STEP === RULES_PER_STEP - 1) yield

			const from = sorted[k] ?? 0

			if (now.cells(from) === was.cells(from)) continue

			for (let row = from; row < (sorted[k + 1] ?? from); row++) rows.add(row)
		}
	}

	return {
		name: (row, col) => cover.name(row, col),
		bounds: row => cover.bounds(row),
		rows,
		breaks,
		lastRow,
		fresh
	}
}
