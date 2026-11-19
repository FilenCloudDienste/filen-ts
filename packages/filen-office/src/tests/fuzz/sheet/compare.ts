import { bytesSource, OpcPackage } from "../../../core/opc/index"
import { toBytes } from "../../../core/xml/editor"
import { decodeUtf8, encodeUtf8, MC_NAMESPACE, Namespaces, parseXml, type XmlDocument } from "../../../core/xml/index"
import {
	CellKind,
	ColFlag,
	FormulaKind,
	RowFlag,
	type XlsxColRange,
	type XlsxSheetModel,
	type XlsxSheetStore
} from "../../../core/xlsx/model/types"
import type { XlsxWorkbook } from "../../../core/xlsx/read/index"
import { formatA1, parseA1, readXlsxCells, type CellScalar, type XlsxCell } from "../../oracles/sheet/xlsxCells"

// The fuzz's invariant: what a session holds equals what its save holds, read back without the engine. Cell
// values, cached results and formulas come from the oracles' plain reader (xlsxCells.ts); everything else a
// session edits is read here from the part text (ECMA-376 Part 1 §18.3.1: rows, cols, mergeCells, the cell
// style index, the cells of each data validation, the autoFilter's range and each hyperlink's; §18.2: sheets and
// definedNames; §18.8: cellXfs, fonts and numFmts), and compared with the model section by section. A difference is
// reported in words, the first few per section.

const SHEET_MAX_COLS = 16_384

export interface CellRecord {
	readonly value: CellScalar | undefined
	readonly style: number
	readonly formula?: { readonly text: string; readonly kind: string; readonly ref?: string; readonly si?: number }
}

export interface RowRecord {
	readonly height: number
	readonly customHeight: boolean
	readonly hidden: boolean
	readonly style: number
}

export interface ColRecord {
	readonly width: number
	readonly style: number
	readonly hidden: boolean
	readonly customWidth: boolean
}

export interface SheetRecord {
	readonly name: string
	readonly state: string
	// Worksheets only: by "row,col".
	readonly cells?: Map<string, CellRecord>
	readonly rows?: Map<number, RowRecord>
	readonly cols?: Map<number, ColRecord>
	readonly merges?: Set<string>
	// The cells of each data validation, in order (the Excel 2010 ones of extLst after "x14 "); the autoFilter's
	// range ("" for none); each hyperlink's cells, in order.
	readonly validations?: string[]
	readonly autoFilter?: string
	readonly links?: string[]
}

export interface XfRecord {
	readonly numFmtId: number
	readonly fontId: number
	readonly fillId: number
	readonly borderId: number
	readonly horizontal: string
	readonly wrap: boolean
}

export interface FontRecord {
	readonly bold: boolean
	readonly italic: boolean
	readonly strike: boolean
	readonly underline: string
	readonly size: number
	readonly name: string
}

export interface WorkbookRecord {
	readonly sheets: SheetRecord[]
	readonly names: Set<string>
	readonly xfs: XfRecord[]
	readonly fonts: FontRecord[]
	readonly numFmts: Map<number, string>
	// Conformance seen on the way (counts that do not match what the part holds).
	readonly problems: string[]
}

function* children(document: XmlDocument, node: number, local?: string): Generator<number> {
	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (local === undefined || document.localName(child) === local) yield child
}

function child(document: XmlDocument, node: number, local: string): number {
	for (const found of children(document, node, local)) return found

	return -1
}

function flag(document: XmlDocument, node: number, name: string): boolean {
	const value = document.attribute(node, name)

	return value === "1" || value === "true"
}

function numberAttribute(document: XmlDocument, node: number, name: string, fallback: number): number {
	const value = document.attribute(node, name)

	return value === undefined || value === "" ? fallback : Number(value)
}

// "A1:B2" (or "A1") as a normalized "r0,c0:r1,c1".
function areaKey(ref: string): string {
	const [first = "", second = first] = ref.split(":")
	const a = parseA1(first)
	const b = parseA1(second)

	return a === undefined || b === undefined ? `?${ref}` : `${a.row},${a.column}:${b.row},${b.column}`
}

// ST_Sqref (§18.18.76): areas separated by spaces, each normalized.
function sqrefKey(text: string): string {
	return text
		.split(/\s+/)
		.filter(ref => ref !== "")
		.map(areaKey)
		.join(" ")
}

// The extension of extLst that holds Excel 2010 data validations ([MS-XLSX] 2.3.6).
const DV_EXT = "{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}"

interface FeatureRecord {
	readonly validations: string[]
	readonly autoFilter: string
	readonly links: string[]
}

// The data validations, autoFilter and hyperlinks among the children of `root` (a worksheet, or the sections the
// model holds wrapped in one element).
function featureRecord(document: XmlDocument, root: number): FeatureRecord {
	const validations: string[] = []
	const links: string[] = []
	let autoFilter = ""

	for (const section of children(document, root)) {
		switch (document.localName(section)) {
			case "dataValidations":
				for (const rule of children(document, section, "dataValidation"))
					validations.push(sqrefKey(document.attribute(rule, "sqref") ?? ""))

				break
			case "autoFilter":
				autoFilter = areaKey(document.attribute(section, "ref") ?? "")

				break
			case "hyperlinks":
				for (const link of children(document, section, "hyperlink")) links.push(areaKey(document.attribute(link, "ref") ?? ""))

				break
			case "extLst":
				for (const ext of children(document, section, "ext")) {
					if ((document.attribute(ext, "uri") ?? "").toUpperCase() !== DV_EXT) continue

					for (const list of children(document, ext, "dataValidations"))
						for (const rule of children(document, list, "dataValidation")) {
							const sqref = child(document, rule, "sqref")

							validations.push(`x14 ${sqrefKey(sqref < 0 ? "" : document.textContent(sqref))}`)
						}
				}

				break
		}
	}

	return { validations, autoFilter, links }
}

const RELATIONSHIP_NAMESPACES = [
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
]

function relationshipId(namespaces: Namespaces, node: number): string | undefined {
	return RELATIONSHIP_NAMESPACES.map(uri => namespaces.attribute(node, uri, "id")).find(value => value !== undefined)
}

function fontRecord(document: XmlDocument, font: number): FontRecord {
	const u = child(document, font, "u")
	const sz = child(document, font, "sz")
	const name = child(document, font, "name")
	const on = (local: string): boolean => {
		const node = child(document, font, local)

		return node >= 0 && document.attribute(node, "val") !== "0" && document.attribute(node, "val") !== "false"
	}

	return {
		bold: on("b"),
		italic: on("i"),
		strike: on("strike"),
		underline: u < 0 ? "none" : (document.attribute(u, "val") ?? "single"),
		size: sz < 0 ? Number.NaN : numberAttribute(document, sz, "val", Number.NaN),
		name: name < 0 ? "" : (document.attribute(name, "val") ?? "")
	}
}

// The saved package read without the engine.
// `source`: the workbook the save came from, or its record read once (a sequence reads its source once). A count it
// already got wrong, which the save kept as written (the writer never rewrites a container it adds nothing to), is
// the source's, not a problem of the save.
export async function readSaved(bytes: Uint8Array, source?: Uint8Array | WorkbookRecord): Promise<WorkbookRecord> {
	const inherited = new Set(
		source === undefined ? [] : source instanceof Uint8Array ? (await readSaved(source)).problems : source.problems
	)
	const cells = await readXlsxCells(bytes)
	const pkg = await OpcPackage.open(bytesSource(bytes))
	const root = await pkg.relationships("")
	const workbookPart = root.all.find(relationship => relationship.type.endsWith("/officeDocument"))?.partName

	if (workbookPart === undefined) throw new Error("no workbook part")

	const workbook = await pkg.xml(workbookPart)
	const relationships = await pkg.relationships(workbookPart)
	const top = workbook.documentElement()
	const namespaces = new Namespaces(workbook, { lenient: true })
	const problems: string[] = []
	const sheets: SheetRecord[] = []
	const sheetsNode = child(workbook, top, "sheets")
	const byPart = new Map(cells.sheets.map(sheet => [sheet.part, sheet]))

	for (const node of sheetsNode < 0 ? [] : children(workbook, sheetsNode, "sheet")) {
		const name = workbook.attribute(node, "name") ?? ""
		const state = workbook.attribute(node, "state") ?? "visible"
		const id = relationshipId(namespaces, node)
		const relationship = id === undefined ? undefined : relationships.byId(id)
		const part = relationship?.partName

		if (part === undefined || !relationship?.type.endsWith("/worksheet")) {
			sheets.push({ name, state })
			continue
		}

		if (!pkg.has(part)) {
			problems.push(`sheet ${name}: part ${part} missing`)
			sheets.push({ name, state })
			continue
		}

		const document = await pkg.xml(part)
		const sheetData = child(document, document.documentElement(), "sheetData")
		const rows = new Map<number, RowRecord>()
		const styles = new Map<string, number>()
		let row = -1

		for (const rowNode of sheetData < 0 ? [] : children(document, sheetData, "row")) {
			const r = document.attribute(rowNode, "r")

			row = r === undefined ? row + 1 : Number(r) - 1

			const height = numberAttribute(document, rowNode, "ht", Number.NaN)
			const record: RowRecord = {
				height,
				customHeight: flag(document, rowNode, "customHeight"),
				hidden: flag(document, rowNode, "hidden"),
				style: flag(document, rowNode, "customFormat") ? numberAttribute(document, rowNode, "s", 0) : -1
			}

			if (!Number.isNaN(record.height) || record.customHeight || record.hidden || record.style >= 0) rows.set(row, record)

			let column = -1

			for (const cellNode of children(document, rowNode, "c")) {
				const ref = document.attribute(cellNode, "r")
				const at = ref === undefined ? undefined : parseA1(ref)

				column = at === undefined ? column + 1 : at.column
				styles.set(`${at?.row ?? row},${column}`, numberAttribute(document, cellNode, "s", 0))
			}
		}

		const cols = new Map<number, ColRecord>()
		const colsNode = child(document, document.documentElement(), "cols")

		for (const col of colsNode < 0 ? [] : children(document, colsNode, "col")) {
			const first = numberAttribute(document, col, "min", 1) - 1
			const last = Math.min(numberAttribute(document, col, "max", first + 1) - 1, SHEET_MAX_COLS - 1)
			const record: ColRecord = {
				width: numberAttribute(document, col, "width", Number.NaN),
				style: numberAttribute(document, col, "style", -1),
				hidden: flag(document, col, "hidden"),
				customWidth: flag(document, col, "customWidth")
			}

			for (let index = first; index <= last; index++) cols.set(index, record)
		}

		const merges = new Set<string>()
		const mergeNode = child(document, document.documentElement(), "mergeCells")

		if (mergeNode >= 0) {
			let count = 0

			for (const merge of children(document, mergeNode, "mergeCell")) {
				merges.add(areaKey(document.attribute(merge, "ref") ?? ""))
				count++
			}

			const declared = document.attribute(mergeNode, "count")

			if (declared !== undefined && Number(declared) !== count)
				problems.push(`sheet ${name}: mergeCells count ${declared}, ${count} held`)
			if (count === 0) problems.push(`sheet ${name}: empty mergeCells`)
		}

		const record = new Map<string, CellRecord>()

		for (const cell of byPart.get(part)?.cells ?? ([] as XlsxCell[])) {
			const key = `${cell.row},${cell.column}`
			const formula = cell.formula

			record.set(key, {
				value: cell.value,
				style: styles.get(key) ?? 0,
				...(formula !== undefined && {
					formula: {
						text: formula.text,
						kind: formula.kind,
						...(formula.ref !== undefined && { ref: areaKey(formula.ref) }),
						...(formula.si !== undefined && { si: Number(formula.si) })
					}
				})
			})
		}

		sheets.push({ name, state, cells: record, rows, cols, merges, ...featureRecord(document, document.documentElement()) })
	}

	const names = new Set<string>()
	const definedNames = child(workbook, top, "definedNames")

	for (const node of definedNames < 0 ? [] : children(workbook, definedNames, "definedName"))
		names.add(
			`${workbook.attribute(node, "name") ?? ""}@${workbook.attribute(node, "localSheetId") ?? ""}=${workbook.textContent(node)}`
		)

	const xfs: XfRecord[] = []
	const fonts: FontRecord[] = []
	const numFmts = new Map<number, string>()
	const stylesPart = relationships.all.find(relationship => relationship.type.endsWith("/styles"))?.partName

	if (stylesPart !== undefined && pkg.has(stylesPart)) {
		const styles = await pkg.xml(stylesPart)
		const sheet = styles.documentElement()
		const markup = new Namespaces(styles, { lenient: true })
		// A record wrapped in mc:AlternateContent is one record: the Fallback a reader that understands none of the
		// Choices' namespaces takes (ECMA-376 Part 3, §10.2), as it would be read.
		const record = (node: number, item: string): number => {
			if (!markup.is(node, MC_NAMESPACE, "AlternateContent")) return styles.localName(node) === item ? node : -1

			for (const branch of children(styles, node, "Fallback"))
				if (markup.is(branch, MC_NAMESPACE, "Fallback")) return child(styles, branch, item)

			return -1
		}
		const container = (local: string, item: string): number[] => {
			const node = child(styles, sheet, local)

			if (node < 0) return []

			const items = [...children(styles, node)].map(entry => record(entry, item)).filter(entry => entry >= 0)
			const declared = styles.attribute(node, "count")

			if (declared !== undefined && Number(declared) !== items.length)
				problems.push(`styles ${local} count ${declared}, ${items.length} held`)

			return items
		}

		for (const numFmt of container("numFmts", "numFmt"))
			numFmts.set(numberAttribute(styles, numFmt, "numFmtId", -1), styles.attribute(numFmt, "formatCode") ?? "")

		for (const font of container("fonts", "font")) fonts.push(fontRecord(styles, font))

		for (const xf of container("cellXfs", "xf")) {
			const alignment = child(styles, xf, "alignment")

			xfs.push({
				numFmtId: numberAttribute(styles, xf, "numFmtId", 0),
				fontId: numberAttribute(styles, xf, "fontId", 0),
				fillId: numberAttribute(styles, xf, "fillId", 0),
				borderId: numberAttribute(styles, xf, "borderId", 0),
				horizontal: alignment < 0 ? "general" : (styles.attribute(alignment, "horizontal") ?? "general"),
				wrap: alignment >= 0 && flag(styles, alignment, "wrapText")
			})
		}
	}

	const stringsPart = relationships.all.find(relationship => relationship.type.endsWith("/sharedStrings"))?.partName

	if (stringsPart !== undefined && pkg.has(stringsPart)) {
		const sst = await pkg.xml(stringsPart)
		const items = [...children(sst, sst.documentElement(), "si")].length
		const unique = sst.attribute(sst.documentElement(), "uniqueCount")

		if (unique !== undefined && Number(unique) !== items) problems.push(`sharedStrings uniqueCount ${unique}, ${items} held`)
	}

	return { sheets, names, xfs, fonts, numFmts, problems: problems.filter(problem => !inherited.has(problem)) }
}

// --- The model, in the same terms ---

function scalar(workbook: XlsxWorkbook, store: XlsxSheetStore, kind: number, value: number): CellScalar | undefined {
	switch (kind) {
		case CellKind.NUMBER:
			return { type: "n", value }
		case CellKind.SHARED_STRING:
			return { type: "s", value: workbook.sharedStrings.text(value) }
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
		case CellKind.DATE:
			return { type: "s", value: store.strings.text(value) }
		case CellKind.BOOLEAN:
			return { type: "b", value: value !== 0 }
		case CellKind.ERROR:
			return { type: "e", value: store.strings.text(value).trim() }
		default:
			return undefined
	}
}

// The sections featureRecord reads.
const FEATURE_SECTIONS = ["autoFilter", "dataValidations", "hyperlinks", "extLst"]

// A worksheet section as the save writes it: through the writer an edit gave it, else as the source holds it.
function sectionMarkup(workbook: XlsxWorkbook, model: XlsxSheetModel, name: string): string {
	const writer = workbook.changes.sheets.get(model.id)?.sections.get(name)

	if (writer !== undefined && writer !== null) return decodeUtf8(toBytes(writer(model, workbook)))

	return model.sections
		.filter(section => section.name === name)
		.map(section => (section.bytes === null ? "" : decodeUtf8(section.bytes)))
		.join("")
}

const FORMULA_KINDS: Readonly<Record<number, string>> = {
	[FormulaKind.NORMAL]: "normal",
	[FormulaKind.SHARED_MASTER]: "shared",
	[FormulaKind.SHARED_CHILD]: "shared",
	[FormulaKind.ARRAY]: "array",
	[FormulaKind.DATA_TABLE]: "dataTable"
}

function colRecord(range: XlsxColRange): ColRecord {
	return {
		width: range.width,
		style: range.style,
		hidden: (range.flags & ColFlag.HIDDEN) !== 0,
		customWidth: (range.flags & ColFlag.CUSTOM_WIDTH) !== 0
	}
}

// What the session's model holds. Unparsed sheets carry their name and state only (their parts are copied).
export function modelRecord(workbook: XlsxWorkbook): WorkbookRecord {
	const sheets: SheetRecord[] = []

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (entry.kind !== "worksheet" || model === null) {
			sheets.push({ name: entry.name, state: entry.state })
			continue
		}

		const store = model.store
		const cells = new Map<string, CellRecord>()
		const rows = new Map<number, RowRecord>()

		for (const block of store.blocks) {
			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)
				const flags = block.rowFlags[i] ?? 0
				const record: RowRecord = {
					height: block.rowHeights[i] ?? Number.NaN,
					customHeight: (flags & RowFlag.CUSTOM_HEIGHT) !== 0,
					hidden: (flags & RowFlag.HIDDEN) !== 0,
					// customFormat without s means style 0 (§18.3.1.73 s defaults to 0).
					style: (flags & RowFlag.CUSTOM_FORMAT) !== 0 ? Math.max(0, block.rowStyles[i] ?? 0) : -1
				}

				if (!Number.isNaN(record.height) || record.customHeight || record.hidden || record.style >= 0) rows.set(row, record)

				for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
					const col = block.cols[k] ?? 0
					const id = block.formulas?.[k] ?? -1
					let formula: CellRecord["formula"]

					if (id >= 0) {
						const kind = store.formulas.kind(id)
						const shape = store.formulas.formula(id)

						formula = {
							text: store.formulas.text(id),
							kind: FORMULA_KINDS[kind] ?? "?",
							...(shape.ref !== null && {
								ref: `${shape.ref.startRow},${shape.ref.startCol}:${shape.ref.endRow},${shape.ref.endCol}`
							}),
							...(shape.sharedIndex >= 0 && { si: shape.sharedIndex })
						}
					}

					cells.set(`${row},${col}`, {
						value: scalar(workbook, store, block.kinds[k] ?? 0, block.values[k] ?? 0),
						style: block.styles[k] ?? 0,
						...(formula !== undefined && { formula })
					})
				}
			}
		}

		const cols = new Map<number, ColRecord>()

		for (const range of model.cols)
			for (let index = range.first; index <= Math.min(range.last, SHEET_MAX_COLS - 1); index++) cols.set(index, colRecord(range))

		const merges = new Set<string>()

		for (let i = 0; i + 3 < model.merges.length; i += 4)
			merges.add(`${model.merges[i] ?? 0},${model.merges[i + 1] ?? 0}:${model.merges[i + 2] ?? 0},${model.merges[i + 3] ?? 0}`)

		const features = FEATURE_SECTIONS.map(name => sectionMarkup(workbook, model, name)).join("")
		const wrapped = features === "" ? null : parseXml(encodeUtf8(`<sections>${features}</sections>`))

		sheets.push({
			name: entry.name,
			state: entry.state,
			cells,
			rows,
			cols,
			merges,
			...(wrapped === null ? { validations: [], autoFilter: "", links: [] } : featureRecord(wrapped, wrapped.documentElement()))
		})
	}

	const names = new Set<string>()

	for (const named of workbook.definedNames) {
		const local = named.sheet === null ? "" : String(workbook.sheets.findIndex(entry => entry.id === named.sheet))

		names.add(`${named.name}@${local}=${named.formula}`)
	}

	const styles = workbook.styles
	const xfs: XfRecord[] = styles.cellXfs.map(xf => ({
		numFmtId: xf.numFmtId,
		fontId: xf.fontId,
		fillId: xf.fillId,
		borderId: xf.borderId,
		horizontal: xf.alignment?.horizontal ?? "general",
		wrap: xf.alignment?.wrapText === true
	}))
	const fonts: FontRecord[] = styles.fonts.map(font => ({
		bold: font.bold === true,
		italic: font.italic === true,
		strike: font.strike === true,
		underline: font.underline ?? "none",
		size: font.size ?? Number.NaN,
		name: font.name ?? ""
	}))

	return { sheets, names, xfs, fonts, numFmts: new Map(styles.numFmts), problems: [] }
}

// --- Comparing ---

// -0 and 0 are one value in a cell (Excel writes no negative zero).
function same(a: unknown, b: unknown): boolean {
	return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))
}

function fields<T extends object>(a: T, b: T): string[] {
	const out: string[] = []

	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const left = (a as Record<string, unknown>)[key]
		const right = (b as Record<string, unknown>)[key]

		if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
			const inner = fields(left, right)

			if (inner.length > 0) out.push(`${key}{${inner.join(",")}}`)
		} else if (!same(left, right)) out.push(`${key} ${JSON.stringify(left)}≠${JSON.stringify(right)}`)
	}

	return out
}

// What `expected` holds and `actual` does not, and the reverse, as a multiset.
function listDifferences(expected: readonly string[], actual: readonly string[]): string[] {
	const counts = new Map<string, number>()

	for (const item of expected) counts.set(item, (counts.get(item) ?? 0) + 1)
	for (const item of actual) counts.set(item, (counts.get(item) ?? 0) - 1)

	return [...counts].flatMap(([item, count]) =>
		count === 0 ? [] : [`${count > 0 ? "missing" : "extra"} ${item}${Math.abs(count) > 1 ? ` ×${Math.abs(count)}` : ""}`]
	)
}

function cellName(key: string): string {
	const [row = "0", col = "0"] = key.split(",")

	return formatA1(Number(row), Number(col))
}

// Differences between the model (`expected`) and the save as read back (`actual`); empty when they agree.
export function compareRecords(expected: WorkbookRecord, actual: WorkbookRecord, limit = 8): string[] {
	const out: string[] = [...actual.problems]
	const push = (section: string, items: string[]): void => {
		if (items.length === 0) return

		out.push(`${section}: ${items.slice(0, limit).join("; ")}${items.length > limit ? ` (+${items.length - limit})` : ""}`)
	}

	push(
		"sheets",
		expected.sheets.length !== actual.sheets.length || expected.sheets.some((sheet, i) => sheet.name !== actual.sheets[i]?.name)
			? [`${expected.sheets.map(sheet => sheet.name).join("|")} ≠ ${actual.sheets.map(sheet => sheet.name).join("|")}`]
			: expected.sheets.flatMap((sheet, i) =>
					sheet.state === actual.sheets[i]?.state ? [] : [`${sheet.name} state ${sheet.state}≠${actual.sheets[i]?.state ?? ""}`]
				)
	)
	push("definedNames", [
		...[...expected.names].filter(name => !actual.names.has(name)).map(name => `missing ${name}`),
		...[...actual.names].filter(name => !expected.names.has(name)).map(name => `extra ${name}`)
	])

	for (const [i, sheet] of expected.sheets.entries()) {
		const saved = actual.sheets[i]

		if (sheet.cells === undefined || saved?.name !== sheet.name) continue
		if (saved.cells === undefined) {
			out.push(`${sheet.name}: not a worksheet in the save`)
			continue
		}

		const cells: string[] = []

		for (const [key, cell] of sheet.cells) {
			const other = saved.cells.get(key)

			if (other === undefined) cells.push(`${cellName(key)} missing`)
			else {
				const differences = fields(cell, other)

				if (differences.length > 0) cells.push(`${cellName(key)} ${differences.join(",")}`)
			}
		}

		for (const key of saved.cells.keys()) if (!sheet.cells.has(key)) cells.push(`${cellName(key)} extra`)

		push(`${sheet.name} cells`, cells)

		const rows: string[] = []

		for (const key of new Set([...(sheet.rows?.keys() ?? []), ...(saved.rows?.keys() ?? [])])) {
			const left = sheet.rows?.get(key)
			const right = saved.rows?.get(key)

			if (left === undefined || right === undefined) rows.push(`row ${key + 1} ${left === undefined ? "extra" : "missing"}`)
			else {
				const differences = fields(left, right)

				if (differences.length > 0) rows.push(`row ${key + 1} ${differences.join(",")}`)
			}
		}

		push(`${sheet.name} rows`, rows)

		const cols: string[] = []

		for (const key of new Set([...(sheet.cols?.keys() ?? []), ...(saved.cols?.keys() ?? [])])) {
			const left = sheet.cols?.get(key)
			const right = saved.cols?.get(key)

			if (left === undefined || right === undefined) cols.push(`col ${key + 1} ${left === undefined ? "extra" : "missing"}`)
			else {
				const differences = fields(left, right)

				if (differences.length > 0) cols.push(`col ${key + 1} ${differences.join(",")}`)
			}
		}

		push(`${sheet.name} cols`, cols)
		push(`${sheet.name} merges`, [
			...[...(sheet.merges ?? [])].filter(merge => !saved.merges?.has(merge)).map(merge => `missing ${merge}`),
			...[...(saved.merges ?? [])].filter(merge => !sheet.merges?.has(merge)).map(merge => `extra ${merge}`)
		])
		push(`${sheet.name} dataValidations`, listDifferences(sheet.validations ?? [], saved.validations ?? []))
		push(
			`${sheet.name} autoFilter`,
			(sheet.autoFilter ?? "") === (saved.autoFilter ?? "") ? [] : [`${sheet.autoFilter || "∅"}≠${saved.autoFilter || "∅"}`]
		)
		push(`${sheet.name} hyperlinks`, listDifferences(sheet.links ?? [], saved.links ?? []))
	}

	// A save writes the model's records up to the last one a cell refers to (records an undone edit appended stay
	// in the model only): the saved records are the model's first ones, and every reference among them holds.
	push(
		"cellXfs",
		actual.xfs.length > expected.xfs.length
			? [`${expected.xfs.length} in the model, ${actual.xfs.length} saved`]
			: actual.xfs.flatMap((xf, i) => {
					const differences = fields(expected.xfs[i] as XfRecord, xf)

					return differences.length === 0 ? [] : [`xf ${i} ${differences.join(",")}`]
				})
	)
	push(
		"fonts",
		actual.fonts.length > expected.fonts.length
			? [`${expected.fonts.length} in the model, ${actual.fonts.length} saved`]
			: actual.fonts.flatMap((font, i) => {
					const differences = fields(expected.fonts[i] as FontRecord, font)

					return differences.length === 0 ? [] : [`font ${i} ${differences.join(",")}`]
				})
	)
	push(
		"numFmts",
		[...actual.numFmts]
			.filter(([id, code]) => expected.numFmts.get(id) !== code)
			.map(([id, code]) => `${id} ${expected.numFmts.get(id) ?? "∅"}≠${code}`)
	)
	push(
		"references",
		actual.xfs.flatMap((xf, i) =>
			(actual.fonts.length > 0 && xf.fontId >= actual.fonts.length) || (xf.numFmtId >= 164 && !actual.numFmts.has(xf.numFmtId))
				? [`xf ${i} names a record not saved`]
				: []
		)
	)

	// Every cell's style must name a saved cell format.
	if (actual.xfs.length > 0)
		for (const sheet of actual.sheets) {
			const bad = [...(sheet.cells?.entries() ?? [])]
				.filter(([, cell]) => cell.style >= actual.xfs.length)
				.map(([key]) => cellName(key))

			push(`${sheet.name} styles out of range`, bad)
		}

	return out
}
