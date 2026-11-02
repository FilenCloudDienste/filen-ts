import { appendAll } from "../../arrays"
import { partKey } from "../../opc/partNames"
import type { SheetId, SheetRange } from "../../sheet/protocol"
import { heldOrSource } from "../comments/parts"
import type { XlsxDocument } from "../edit/document"
import type { XlsxDefinedName, XlsxWorkbookModel } from "../model/types"
import { refState } from "../refs/state"
import { chartReferences, isPivotChart } from "./cache"
import { chartNames, hiddenSignature } from "./cells"
import { chartAreas, type ChartArea, type ChartNameLookup } from "./refs"
import { CHART_TYPE } from "./parts"
import { drawingReader } from "../../drawingml/reader"
import { parseXml } from "../../xml/index"

// A workbook's charts as the charts feature tracks them: each chart part's current bytes, the cells its references
// read, and which charts read cells an edit changed since the last save (their caches are refreshed then) or since
// they were last drawn (their stamp moves on). Source bytes are read once, when the first sheet opens.

// Charts whose references read more areas than this are refreshed on any edit of their sheets.
const MAX_AREAS = 1024

// What a chart's references read: its areas (null: more than are tracked), and the defined names they were resolved
// through, with the formula each stood for (by "sheet!NAME", upper case), checked again once the names change.
interface ChartReads {
	readonly areas: readonly ChartArea[] | null
	readonly names: ReadonlyMap<string, string | undefined>
	epoch: number
}

function sameAreas(a: readonly ChartArea[] | null, b: readonly ChartArea[] | null): boolean {
	if (a === null || b === null) return a === b
	if (a.length !== b.length) return false

	return a.every((area, index) => {
		const other = b[index]

		return (
			other !== undefined &&
			area.sheet.toUpperCase() === other.sheet.toUpperCase() &&
			area.range.startRow === other.range.startRow &&
			area.range.startCol === other.range.startCol &&
			area.range.endRow === other.range.endRow &&
			area.range.endCol === other.range.endCol
		)
	})
}

export class ChartBook {
	readonly workbook: XlsxWorkbookModel
	private readonly source = new Map<string, Uint8Array>()
	// The source's chart parts (by partKey), listed once: parts edits add or remove are read from the change log.
	private sourceCharts: ReadonlyMap<string, string> | null = null
	private loading: Promise<void> | null = null
	private loaded = false
	// Changes heard before the charts were read: replayed once they are.
	private pending: { sheet: string; range: SheetRange }[] | null = []
	// Charts whose cells or bytes changed since the workbook was opened, by partKey: each save refreshes their caches
	// for that save only (the model keeps the bytes edits gave them).
	readonly dirty = new Set<string>()
	// Moves on with every change a chart reads (its drawing is then stale), by partKey.
	private readonly generations = new Map<string, number>()
	private readonly reads = new WeakMap<Uint8Array, ChartReads>()
	// The workbook's defined names as last seen (their entries are replaced, never changed, when an edit moves them),
	// and a count that moves on each time they differ.
	private names: readonly XlsxDefinedName[]
	private namesEpoch = 0
	// The last save's refresh of each chart (by partKey): from which bytes, at which generation, to which bytes.
	private readonly refreshes = new Map<string, { readonly from: Uint8Array; readonly generation: number; readonly to: Uint8Array }>()
	// Each sheet's hidden rows and columns as last drawn (hiddenSignature), by sheet.
	private readonly hidden = new Map<SheetId, number>()
	private readonly serials = new WeakMap<Uint8Array, number>()
	private serial = 0

	constructor(workbook: XlsxWorkbookModel) {
		this.workbook = workbook
		this.names = workbook.definedNames.slice()
	}

	// Reads every chart part's source bytes once (concurrent calls share it).
	load(document: XlsxDocument): Promise<void> {
		this.loading ??= this.read(document)

		return this.loading
	}

	private async read(document: XlsxDocument): Promise<void> {
		for (const name of this.parts()) {
			const part = this.workbook.parts.get(name)

			if (part?.source === null || part?.source === undefined || this.source.has(partKey(name))) continue

			try {
				this.source.set(partKey(name), await this.workbook.parts.read(name))
			} catch {
				// A part that does not inflate draws nothing and is never refreshed.
			}
		}

		this.loaded = true

		const pending = this.pending ?? []

		this.pending = null

		for (const change of pending) this.changed(document, change.sheet, change.range)
	}

	// Every chart part as it now is (chartParts), without walking the package's parts again.
	parts(): string[] {
		if (this.sourceCharts === null) {
			const out = new Map<string, string>()

			for (const part of this.workbook.parts.parts())
				if (part.contentType.toLowerCase() === CHART_TYPE) out.set(partKey(part.name), part.name)

			this.sourceCharts = out
		}

		const out = new Map(this.sourceCharts)

		for (const [name, write] of this.workbook.changes.parts) {
			if (write === null) out.delete(partKey(name))
			else if (write.contentType.toLowerCase() === CHART_TYPE) out.set(partKey(name), name)
		}

		return [...out.values()]
	}

	// A chart part's bytes as they now are: null when removed or never read.
	bytes(name: string): Uint8Array | null {
		return heldOrSource(this.workbook, name, this.source) ?? null
	}

	// The bytes an edit starts from, read when they were not yet.
	async current(name: string): Promise<Uint8Array | null> {
		const bytes = this.bytes(name)

		if (bytes !== null || refState(this.workbook).heldPart(name) !== undefined) return bytes

		const part = this.workbook.parts.get(name)

		if (part?.source === null || part?.source === undefined) return null
		if ([...this.workbook.changes.parts].some(([changed, write]) => partKey(changed) === partKey(name) && write === null)) return null

		const read = await this.workbook.parts.read(name)

		this.source.set(partKey(name), read)

		return this.bytes(name)
	}

	private syncNames(): void {
		const names = this.workbook.definedNames

		if (names.length === this.names.length && names.every((name, index) => name === this.names[index])) return

		this.names = names.slice()
		this.namesEpoch++
	}

	private readAreas(document: XlsxDocument, bytes: Uint8Array): ChartReads {
		const out: ChartArea[] = []
		const used = new Map<string, string | undefined>()
		const lookup = chartNames(document)
		const names: ChartNameLookup = (name, sheet) => {
			const formula = lookup(name, sheet)

			used.set(`${sheet?.toUpperCase() ?? ""}!${name.toUpperCase()}`, formula)

			return formula
		}

		try {
			const reader = drawingReader(parseXml(bytes))

			// A pivot chart's caches are its pivot table's: no cell edit changes what it shows.
			if (!isPivotChart(reader))
				for (const reference of chartReferences(reader)) appendAll(out, chartAreas(reference.formula, names) ?? [])
		} catch {
			out.length = 0
		}

		return { areas: out.length > MAX_AREAS ? null : out, names: used, epoch: this.namesEpoch }
	}

	// What a chart's references read, and whether that moved because a defined name they read changed.
	private readsOf(document: XlsxDocument, bytes: Uint8Array): { reads: ChartReads; moved: boolean } {
		const found = this.reads.get(bytes)

		if (found !== undefined && found.epoch === this.namesEpoch) return { reads: found, moved: false }
		if (found !== undefined && found.names.size === 0) {
			found.epoch = this.namesEpoch

			return { reads: found, moved: false }
		}

		if (found !== undefined) {
			const lookup = chartNames(document)
			const same = [...found.names].every(([key, formula]) => {
				const split = key.indexOf("!")

				return lookup(key.slice(split + 1), split === 0 ? null : key.slice(0, split)) === formula
			})

			if (same) {
				found.epoch = this.namesEpoch

				return { reads: found, moved: false }
			}
		}

		const reads = this.readAreas(document, bytes)

		this.reads.set(bytes, reads)

		return { reads, moved: found !== undefined && !sameAreas(found.areas, reads.areas) }
	}

	// Cells of `sheet` (its name) changed: the charts reading them are stale. So are the charts reading a defined name
	// that now stands for other cells.
	changed(document: XlsxDocument, sheet: string, range: SheetRange): void {
		if (this.pending !== null) {
			this.pending.push({ sheet, range })

			return
		}

		this.syncNames()

		const upper = sheet.toUpperCase()

		for (const name of this.parts()) {
			const bytes = this.bytes(name)

			if (bytes === null) continue

			const { reads, moved } = this.readsOf(document, bytes)
			const areas = reads.areas
			const touched =
				moved ||
				areas === null ||
				areas.some(
					area =>
						area.sheet.toUpperCase() === upper &&
						area.range.startRow <= range.endRow &&
						range.startRow <= area.range.endRow &&
						area.range.startCol <= range.endCol &&
						range.startCol <= area.range.endCol
				)

			if (touched) this.touch(name)
		}
	}

	// The sheet's layout changed: when its hidden rows or columns did, every chart reading it is drawn again (one of
	// visible cells shows other points). What a save writes never depends on them, so nothing is refreshed then.
	layoutChanged(document: XlsxDocument, sheet: SheetId): void {
		if (!this.loaded) return

		const model = document.model(sheet)
		const name = document.entry(sheet)?.name

		if (model === null || name === undefined) return

		const signature = hiddenSignature(model)

		if (this.hidden.get(sheet) === signature) return

		this.hidden.set(sheet, signature)
		this.syncNames()

		const upper = name.toUpperCase()

		for (const part of this.parts()) {
			const bytes = this.bytes(part)

			if (bytes === null) continue

			const { reads, moved } = this.readsOf(document, bytes)

			if (moved) this.touch(part)
			else if (reads.areas === null || reads.areas.some(area => area.sheet.toUpperCase() === upper)) this.redraw(part)
		}
	}

	// The sheets a drawing of a chart read (upper-case names) as they now are: what a later layout change compares to.
	shown(document: XlsxDocument, names: ReadonlySet<string>): void {
		for (const entry of document.worksheets()) {
			if (!names.has(entry.name.toUpperCase()) || this.hidden.has(entry.id)) continue

			const model = document.model(entry.id)

			if (model !== null) this.hidden.set(entry.id, hiddenSignature(model))
		}
	}

	private redraw(name: string): void {
		const key = partKey(name)

		this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
	}

	// A chart whose bytes or data changed: stale where drawn, refreshed at every save from now on.
	touch(name: string): void {
		this.dirty.add(partKey(name))
		this.redraw(name)
	}

	// The refresh a save made of `bytes` when nothing it reads changed since; undefined otherwise.
	refreshed(name: string, bytes: Uint8Array): Uint8Array | undefined {
		const key = partKey(name)
		const last = this.refreshes.get(key)

		return last !== undefined && last.from === bytes && last.generation === (this.generations.get(key) ?? 0) ? last.to : undefined
	}

	rememberRefresh(name: string, from: Uint8Array, to: Uint8Array): void {
		const key = partKey(name)

		this.refreshes.set(key, { from, generation: this.generations.get(key) ?? 0, to })
	}

	get ready(): boolean {
		return this.loaded
	}

	// What a drawing of the chart reflects: its bytes and the data changes since.
	stamp(name: string, bytes: Uint8Array): string {
		let serial = this.serials.get(bytes)

		if (serial === undefined) {
			serial = ++this.serial
			this.serials.set(bytes, serial)
		}

		return `${String(serial)}.${String(this.generations.get(partKey(name)) ?? 0)}`
	}
}

const books = new WeakMap<XlsxWorkbookModel, ChartBook>()

export function chartBook(workbook: XlsxWorkbookModel): ChartBook {
	let book = books.get(workbook)

	if (book === undefined) {
		book = new ChartBook(workbook)
		books.set(workbook, book)
	}

	return book
}
