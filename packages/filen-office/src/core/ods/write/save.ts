import { appendAll } from "../../arrays"
import { nativeDeflate, nativeDeflateChunks } from "../../docx/write/zip"
import { bytesSource, memorySink, planZip, writeZip, type ByteChunks, type PartChange } from "../../opc/index"
import type { InflateHook } from "../../opc/zipReader"
import { SliceClock, sliceClock, type Slicing } from "../../slicing"
import type { XlsxDocument } from "../../xlsx/edit/document"
import type { XlsxSheetModel } from "../../xlsx/model/types"
import { decodeUtf8, encodeUtf8, escapeAttribute } from "../../xml/index"
import { OdfNs } from "../../odf/namespaces"
import { NULL_DATE_1899, NULL_DATE_1904 } from "../read/values"
import { odsSource, type OdsSource } from "../source"
import { verifyOds } from "../verify"
import { CellRefused } from "./cells"
import { ContentRefused, ContentWriter } from "./content"
import { StreamError } from "./stream"
import { OdsStyleWriter, StyleRefused, StyleUnplanned } from "./styles"
import { ChartRefused, writeOdsCharts } from "../charts/write"
import { currentSection, sectionText, sheetFeatures, type SheetFeatures } from "./features"
import { ValidationRefused } from "./validations"
import { FilterRefused, filterRange } from "./filters"
import type { NewTable } from "./table"
import { NameRefused, namesPlan, scopeSheetName } from "./names"
import type { SourceAxis } from "./axis"
import { proveSpan } from "./span"
import { shifterOf } from "../unheld"
import { SHEET_MAX_ROWS } from "../../sheet/protocol"
import { sameView, writeSettings, type SheetViewState } from "./settings"

// The OpenDocument save: content.xml streamed through the splice writer (ContentWriter), every other entry copied
// as its compressed bytes, then the whole file read back by the reader and compared with the session's model
// (verify.ts). It never throws: what it cannot write comes back as a refusal with its reason, and the session stays
// dirty.

export type OdsSaveResult =
	| { readonly ok: true; readonly bytes: Uint8Array; readonly changedParts: readonly string[] }
	| { readonly ok: false; readonly reason: "write" | "verify" | "unsupported"; readonly message: string }

export interface OdsSaveOptions {
	readonly slicing?: Slicing
	readonly signal?: { readonly aborted: boolean }
	readonly inflate?: InflateHook
	// Nothing was edited: the source as it is.
	readonly untouched?: boolean
	// What new tables hold beyond the model, by sheet (a conversion's page setup and conditional formats).
	readonly newTables?: ReadonlyMap<number, NewTable>
}

const CONTENT = "content.xml"

// The autoFilters an edit changed (or a rename or a moved row or column moved): each as its database range now.
function filterPlan(document: XlsxDocument, source: OdsSource): { replaced: Map<string, string | null>; added: string[] } {
	const replaced = new Map<string, string | null>()
	const added: string[] = []
	const workbook = document.workbook

	workbook.sheets.forEach((entry, position) => {
		const model = entry.model

		if (model === null || entry.kind !== "worksheet") return

		const table = source.tables[entry.id]
		const own = table !== undefined && table.id === entry.id && "rowAxis" in model ? table : null
		const axes = model as { rowAxis?: SourceAxis; colAxis?: SourceAxis }
		const current = currentSection(workbook, model, "autoFilter")
		const moved = axes.rowAxis?.identity === false || axes.colAxis?.identity === false

		if (current === null && own !== null && own.name === entry.name && !moved) return

		const markup = current ?? sectionText(model.sections, "autoFilter")
		const range = filterRange(markup, entry.name, `__Anonymous_Sheet_DB__${String(position)}`)
		const before = own === null ? "" : sectionText(own.sections, "autoFilter")

		if (own !== null && before !== "") replaced.set(own.name, range)
		else if (range !== null) added.push(range)
	})

	return { replaced, added }
}
const SETTINGS = "settings.xml"

// settings.xml where a sheet's view or the active sheet changed (renamed sheets keep theirs), null when it stays.
async function settingsChange(document: XlsxDocument, source: OdsSource): Promise<{ bytes: Uint8Array; fresh: boolean } | null> {
	const entry = source.odf.archive.get(SETTINGS)

	const sheets: SheetViewState[] = []
	let renamed = false

	for (const sheet of document.workbook.sheets) {
		const model = sheet.model

		if (model === null || sheet.kind !== "worksheet") continue

		const table = source.tables[sheet.id]
		const own = table !== undefined && table.id === sheet.id && "rowAxis" in model ? table : undefined

		if (own !== undefined && own.name !== sheet.name) renamed = true

		sheets.push({
			name: sheet.name,
			sourceName: own?.name,
			view: model.view,
			changed: own === undefined || !sameView(model.view, own.view)
		})
	}

	const activeId = document.activeSheet()
	const active = document.workbook.sheets.find(sheet => sheet.id === activeId)
	const sourceActive = source.tables[source.activeTab]
	// The sheet the written file opens on if ActiveTable stays: the one it names, else the first (sheets moved, added or
	// renamed change which that is).
	const stated = source.settings.activeTable
	const readBack = document.workbook.sheets.find(sheet => stated !== undefined && sheet.name === stated) ?? document.workbook.sheets[0]
	const activeChanged = active?.id !== sourceActive?.id || active?.name !== sourceActive?.name || readBack?.id !== sourceActive?.id

	if (!activeChanged && !renamed && sheets.every(sheet => !sheet.changed)) return null

	// A package without settings.xml gets one (and its manifest entry) once a view is to be kept.
	const bytes =
		entry === undefined ? encodeUtf8(emptySettings(source.version ?? source.odf.facts.version)) : await source.odf.archive.read(entry)
	const written = writeSettings(bytes, active?.name ?? "", activeChanged || entry === undefined, sheets)

	return written === null ? null : { bytes: written, fresh: entry === undefined }
}

// Of the package's own ODF version (content.xml's, else its manifest's), as each of its parts must be (Part 2 §4.3).
// xmlns:ooo declares the prefix of the "ooo:view-settings" name LibreOffice looks the views up by.
const emptySettings = (version: string | undefined): string =>
	`<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="${OdfNs.office}" xmlns:config="${OdfNs.config}" xmlns:ooo="${OdfNs.ooo}"${version === undefined ? "" : ` office:version="${escapeAttribute(version)}"`}><office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry><config:config-item config:name="ViewId" config:type="string">view1</config:config-item></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>`

// META-INF/manifest.xml with an entry for a part added (ODF 1.3 Part 2 §4.3).
async function withManifestEntry(source: OdsSource, path: string, mediaType: string): Promise<PartChange | null> {
	const entry = source.odf.archive.get(MANIFEST)

	if (entry === undefined) return null

	const text = decodeUtf8(await source.odf.archive.read(entry))
	const close = text.lastIndexOf("</manifest:manifest>")

	if (close < 0) return null

	const line = `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${mediaType}"/>`

	return { name: MANIFEST, bytes: encodeUtf8(text.slice(0, close) + line + text.slice(close)) }
}

const MANIFEST = "META-INF/manifest.xml"

// The source content.xml's entry as it streams out of the archive.
function contentStream(source: OdsSource): AsyncIterable<Uint8Array> {
	return source.odf.archive.stream(source.content)
}

const CHUNK = 64 * 1024

class ContentBytes implements ByteChunks {
	private produced = 0
	private readonly writer: ContentWriter
	private readonly source: OdsSource
	private readonly clock: SliceClock | undefined

	constructor(writer: ContentWriter, source: OdsSource, clock: SliceClock | undefined) {
		this.writer = writer
		this.source = source
		this.clock = clock
	}

	// Read after the pieces were (the zip writer takes the size once they are through).
	get length(): number {
		return this.produced
	}

	// Pieces joined into chunks of CHUNK bytes at least: the deflater is fed one await per chunk, not per row.
	async *chunks(): AsyncIterable<Uint8Array> {
		const buffer = new Uint8Array(CHUNK)
		let length = 0

		for await (const piece of this.writer.write(contentStream(this.source))) {
			const bytes = typeof piece === "string" ? encodeUtf8(piece) : piece

			this.produced += bytes.length

			if (length + bytes.length > CHUNK) {
				if (length > 0) yield buffer.slice(0, length)

				length = 0
			}

			if (bytes.length >= CHUNK) yield bytes
			else {
				buffer.set(bytes, length)
				length += bytes.length
			}

			if (this.clock?.due === true) await this.clock.pause()
		}

		if (length > 0) yield buffer.slice(0, length)
	}
}

async function zip(
	source: OdsSource,
	replace: readonly PartChange[],
	clock: SliceClock | undefined,
	add: readonly PartChange[] = []
): Promise<Uint8Array> {
	const archive = source.odf.archive
	const plan = planZip({ entries: archive.entries, comment: archive.comment, zip64: archive.zip64 }, { replace, add })
	const sink = memorySink()
	const deflate = nativeDeflate()
	const deflateChunks = nativeDeflateChunks()

	await writeZip(plan, archive, sink, {
		...(deflate !== undefined && { deflate }),
		...(deflateChunks !== undefined && { deflateChunks }),
		...(clock !== undefined && { slicing: clock })
	})

	return sink.bytes()
}

// Thrown at a slice's end once the save's signal is aborted (a close meanwhile): the rest is not worked through.
class SaveAborted extends Error {}

function abortableClock(slicing: Slicing, signal: { readonly aborted: boolean } | undefined): SliceClock {
	if (signal === undefined) return sliceClock(slicing)

	return new SliceClock({
		sliceMs: slicing.sliceMs,
		now: slicing.now,
		pause: async () => {
			if (signal.aborted) throw new SaveAborted("The save was aborted")

			await slicing.pause()

			if (signal.aborted) throw new SaveAborted("The save was aborted")
		}
	})
}

function refusalOf(error: unknown): OdsSaveResult {
	if (error instanceof SaveAborted) return { ok: false, reason: "write", message: error.message }
	if (error instanceof StyleRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof CellRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof ContentRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof ChartRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof NameRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof ValidationRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof FilterRefused) return { ok: false, reason: "unsupported", message: error.message }
	if (error instanceof StreamError) return { ok: false, reason: "write", message: error.message }

	return { ok: false, reason: "write", message: error instanceof Error ? error.message : String(error) }
}

// Tests: the whole file's proof after the span's too, which must never accept what the whole one refuses.
export const odsProof = { whole: false }

// Whether a save can be proved by the rows and columns it wrote: the sheets as the source has them, no row moved, no
// note, link or validation changed, and nothing written past rows, columns and styles.
function spanGate(document: XlsxDocument, source: OdsSource, writer: ContentWriter): boolean {
	if (writer.spanBlocked) return false
	// A row holding formulas the model does not hold written again: the whole file's proof compares those.
	for (const tableWriter of writer.tableWriters.values()) if (tableWriter.rewroteUnheld) return false

	const sheets = document.workbook.sheets.filter(entry => entry.kind === "worksheet")

	if (sheets.length !== source.tables.length) return false

	return sheets.every((entry, index) => {
		const table = source.tables[index]
		const model = entry.model as (XlsxSheetModel & { rowAxis?: SourceAxis; colAxis?: SourceAxis; movedFrom?: number }) | null
		const tableWriter = writer.tableWriters.get(entry.id)
		const features = tableWriter?.features

		return (
			table !== undefined &&
			table.id === entry.id &&
			table.name === entry.name &&
			model !== null &&
			model.rowAxis?.identity !== false &&
			(model.movedFrom === undefined || model.movedFrom >= SHEET_MAX_ROWS) &&
			(features === undefined ||
				(features.notes === null &&
					features.links === null &&
					// A sheet with no validation, before or now (columns moving still give it a plan, empty).
					(features.validations === null ||
						(features.validations.rows.size === 0 &&
							features.validations.fresh.length === 0 &&
							table.validationNames.size === 0))))
		)
	})
}

export async function saveOds(document: XlsxDocument, options: OdsSaveOptions = {}): Promise<OdsSaveResult> {
	const source = odsSource(document.workbook)

	if (source === undefined) return { ok: false, reason: "unsupported", message: "The workbook has no OpenDocument source" }

	try {
		const clock = options.slicing === undefined ? undefined : abortableClock(options.slicing, options.signal)

		if (options.untouched === true) return { ok: true, bytes: await zip(source, [], clock), changedParts: [] }

		const charts = await writeOdsCharts(document, source)
		const filters = filterPlan(document, source)
		const names = namesPlan(document.workbook.definedNames, source.definedNames, scopeSheetName(document))
		const features = new Map<number, SheetFeatures>()
		const taken = new Set(source.validationNames)

		for (const entry of document.workbook.sheets) {
			const model = entry.model

			if (model === null || entry.kind !== "worksheet") continue

			const table = source.tables[entry.id]
			const own = table !== undefined && table.id === entry.id && "rowAxis" in model ? table : null

			if (clock?.due === true) await clock.pause()

			features.set(entry.id, await sheetFeatures(document.workbook, source, model, entry.name, own, taken, clock))
		}

		// The styles planned for the rows whose tags change; where that plan misses one, planned for every row that
		// could name one.
		for (const broad of [false, true]) {
			try {
				const styles = new OdsStyleWriter(source.styles, document.styles)
				const unheld = source.unheld
				const shifter = unheld.items.length === 0 ? null : shifterOf(document.workbook, source.tables)
				const moving = shifter !== null && shifter.changed ? shifter : null
				const writer = new ContentWriter({
					shifter: moving,
					source,
					document,
					styles,
					shapes: charts.shapes,
					features,
					filters,
					names,
					clock,
					broadStyles: broad,
					nullDate: document.workbook.date1904 ? NULL_DATE_1904 : NULL_DATE_1899,
					...(options.newTables !== undefined && { newTables: options.newTables })
				})
				const content = new ContentBytes(writer, source, clock)
				const others: PartChange[] = [...charts.replace]
				const settings = await settingsChange(document, source)
				const added: PartChange[] = []

				if (settings !== null) {
					if (settings.fresh) {
						const manifest = await withManifestEntry(source, SETTINGS, "text/xml")

						if (manifest === null) return { ok: false, reason: "unsupported", message: "The manifest cannot list settings.xml" }

						others.push(manifest)
						added.push({ name: SETTINGS, bytes: settings.bytes })
					} else {
						others.push({ name: SETTINGS, bytes: settings.bytes })
					}
				}

				let bytes = await zip(source, [{ name: CONTENT, bytes: content }, ...others], clock, added)
				const changed: string[] = [CONTENT, ...others.map(change => change.name)]

				// Written as it was (every edit undone): the source's entry as stored.
				if (!writer.changed && content.length === source.content.uncompressedSize) {
					bytes = await zip(source, others, clock, added)
					changed.splice(0, 1)
				}

				appendAll(
					changed,
					added.map(change => change.name)
				)

				if (options.signal?.aborted === true) return { ok: false, reason: "write", message: "The save was aborted" }

				// Rows and styles changed alone: the rows written are read back; else, or where that cannot tell, all of it.
				const span =
					others.length === 0 &&
					added.length === 0 &&
					moving === null &&
					spanGate(document, source, writer) &&
					(await proveSpan(document, source, writer.tableWriters, bytes, options.inflate, clock))

				if (!span || odsProof.whole) {
					const proof = await verifyOds(document, bytesSource(bytes), options.inflate, clock)

					if (!proof.ok)
						return {
							ok: false,
							reason: "verify",
							message: span ? `The span's proof accepted what the whole file's refuses: ${proof.message}` : proof.message
						}
				}

				return { ok: true, bytes, changedParts: changed }
			} catch (error) {
				if (broad || !(error instanceof StyleUnplanned)) throw error
			}
		}

		throw new StyleUnplanned("No style plan wrote the content")
	} catch (error) {
		return refusalOf(error)
	}
}
