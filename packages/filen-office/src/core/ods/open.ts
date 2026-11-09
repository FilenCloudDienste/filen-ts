import { OdfPackage } from "../odf/package"
import { readStyleSheet } from "../odf/load"
import { metaTitle } from "../odf/meta"
import { OdfStyleResolver } from "../odf/resolve"
import { OpcPackage } from "../opc/package"
import type { ByteSource } from "../opc/io"
import type { InflateHook } from "../opc/zipReader"
import { runSliced, sliceClock, type Slicing } from "../slicing"
import { XlsxReadError } from "../xlsx/read/errors"
import { DEFAULT_XLSX_LIMITS, type XlsxLimits } from "../xlsx/read/limits"
import { XlsxParts } from "../xlsx/package/parts"
import type { XlsxOpenFailure } from "../xlsx/package/open"
import { ChangeLog } from "../xlsx/model/changes"
import { SharedStrings } from "../xlsx/model/sharedStrings"
import type { XlsxDefinedName, XlsxSheetEntry, XlsxSheetModel } from "../xlsx/model/types"
import { XlsxWorkbook } from "../xlsx/model/workbook"
import { OdsIssues, type OdsIssue } from "./issues"
import { ContentReader, type OdsContent } from "./read/content"
import { OdsReadError } from "./read/errors"
import { OdsCellStyles } from "./styles/cell"
import { numFmtLocaleFor } from "./styles/locale"
import { buildSheetsSteps, type OdsWorkbookParts } from "./workbook"
import { readSettings } from "./settings"
import { setOdsSource } from "./source"
import { cellPrint, withCached } from "./unheld"
import { OdfNs } from "../odf/namespaces"
import { readOdsCharts } from "./charts/read"
import { DEFAULT_VIEW } from "../xlsx/read/worksheet"

export type OdsOpenFailure = XlsxOpenFailure

export type OdsOpenResult =
	| { readonly ok: true; readonly workbook: XlsxWorkbook; readonly issues: readonly OdsIssue[] }
	| { readonly ok: false; readonly reason: OdsOpenFailure; readonly message: string }

export interface OdsOpenOptions {
	readonly slicing?: Slicing
	readonly signal?: { readonly aborted: boolean }
	readonly inflate?: InflateHook
	readonly readLimits?: Partial<XlsxLimits>
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
// Repeats past the caps that leave content out of the model (read/sheet.ts).
const TRUNCATING: ReadonlySet<string> = new Set(["cell copies", "row copies", "rows past the last", "cells past the last column", "merges"])

// Opens an OpenDocument spreadsheet (.ods, .ots) into the xlsx workbook model, read-only: the package and its styles,
// then content.xml in one streamed pass that builds every sheet. Never throws: every failure is a typed result. An
// encrypted package is refused ("encrypted"), as core/odf refuses it.
export async function openOds(source: ByteSource, options: OdsOpenOptions = {}): Promise<OdsOpenResult> {
	try {
		return await open(source, options)
	} catch (error) {
		if (error instanceof OdsReadError || error instanceof XlsxReadError) {
			switch (error.code) {
				case "tooLarge":
					return { ok: false, reason: "tooLarge", message: error.message }
				case "aborted":
					return { ok: false, reason: "aborted", message: error.message }
				default:
					return { ok: false, reason: "malformed", message: error.message }
			}
		}

		if (options.signal?.aborted === true) return { ok: false, reason: "aborted", message: "Opening was aborted" }

		return { ok: false, reason: "failed", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
	}
}

async function open(source: ByteSource, options: OdsOpenOptions): Promise<OdsOpenResult> {
	const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.readLimits }
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
	const opened = await OdfPackage.open(source, {
		kinds: ["spreadsheet"],
		...(options.inflate !== undefined && { inflate: options.inflate })
	})

	if (!opened.ok) {
		switch (opened.reason) {
			case "encrypted":
				return { ok: false, reason: "encrypted", message: opened.message }
			case "notZip":
				return { ok: false, reason: "notZip", message: opened.message }
			case "compoundFile":
				return { ok: false, reason: "compoundFile", message: opened.message }
			case "tooLarge":
				return { ok: false, reason: "tooLarge", message: opened.message }
			case "notOdf":
			case "wrongKind":
				return { ok: false, reason: "notSpreadsheet", message: opened.message }
			default:
				return { ok: false, reason: "invalidPackage", message: opened.message }
		}
	}

	const odf = opened.package
	const entry = odf.archive.get("content.xml")

	if (entry === undefined) return { ok: false, reason: "invalidPackage", message: "The package has no content.xml" }
	if (entry.uncompressedSize > limits.maxSheetPart) return { ok: false, reason: "tooLarge", message: "content.xml is too large" }

	const { sheet, prologue } = await readStyleSheet(odf, clock)

	if (prologue === undefined || prologue.bodyStart < 0)
		return { ok: false, reason: "malformed", message: "content.xml has no office:body" }
	if (!prologue.sliced && (await isUtf16(odf, entry))) return { ok: false, reason: "unsupported", message: "content.xml is not UTF-8" }

	const prefixes = new Map<string, string>()

	for (const { name, value } of prologue.document.attributes(prologue.root)) {
		if (name === "xmlns") prefixes.set("", value)
		else if (name.startsWith("xmlns:")) prefixes.set(name.slice(6), value)
	}

	prefixes.set("xml", XML_NAMESPACE)

	const version = prologue.document
		.attributes(prologue.root)
		.find(({ name }) => name.endsWith(":version") && prefixes.get(name.slice(0, -8)) === OdfNs.office)?.value

	const issues = new OdsIssues()
	const styles = new OdsCellStyles(sheet, new OdfStyleResolver(sheet), issues)
	const sharedStrings = SharedStrings.empty(() => null)
	const reader = new ContentReader(styles, issues, sharedStrings, prefixes, prologue.bodyStart, limits.maxCells, limits.maxSheets)
	let content: OdsContent

	try {
		content = await reader.read(odf.archive.stream(entry), clock, options.signal)
	} catch (error) {
		if (error instanceof OdsReadError) throw error
		if (options.signal?.aborted === true) throw new OdsReadError("aborted", "Opening was aborted")

		throw new OdsReadError("malformed", error instanceof Error ? error.message : String(error))
	}

	const settings = await readSettings(odf, clock)
	const title = await metaTitle(odf, clock)
	const charts = await readOdsCharts({
		odf,
		prefixes,
		tables: content.tables.map((table, index) => ({ index, name: table.name, shapes: table.shapes, frames: table.frames })),
		issues
	})
	const built: OdsWorkbookParts = await runSliced(buildSheetsSteps(content, styles, settings, issues, prefixes, charts), clock)
	const opc = OpcPackage.fromParts(built.parts)
	const parts = new XlsxParts(opc, await opc.contentTypes())
	const models = new Map<number, XlsxSheetModel>()

	for (const sheetModel of built.models) models.set(sheetModel.id, sheetModel)

	const sheets: XlsxSheetEntry[] = built.entries
	const definedNames: XlsxDefinedName[] = built.definedNames
	const date1904 = built.date1904
	const workbook = new XlsxWorkbook({
		format: "ods",
		loader: entry => {
			const model = models.get(entry.id)

			return model === undefined ? Promise.reject(new XlsxReadError("missingPart", `No sheet ${entry.name}`)) : Promise.resolve(model)
		},
		localeFor: numFmtLocaleFor,
		standardPrecision: styles.standardPrecision,
		variant: "xlsx",
		strict: false,
		parts,
		workbookPart: "xl/workbook.xml",
		workbookSections: [],
		sheets,
		definedNames,
		styles: styles.table,
		sharedStrings,
		theme: null,
		date1904,
		calc: {
			calcId: 0,
			mode: "auto",
			fullCalcOnLoad: false,
			iterate: built.iterate.enabled,
			iterateCount: built.iterate.count,
			iterateDelta: built.iterate.delta
		},
		protection: built.protection,
		fileSharing: null,
		activeTab: built.activeTab,
		changes: new ChangeLog(name => parts.loadedRelationships(name)),
		limits,
		macros: odf.facts.macros,
		signatures: odf.facts.signed ? 1 : 0,
		...(title === undefined ? {} : { title })
	})

	// Every model is built: the sheets read as parsed.
	for (const sheetEntry of sheets) sheetEntry.model = models.get(sheetEntry.id) ?? null

	const read = issues.list()

	setOdsSource(workbook, {
		odf,
		version,
		validationNames: new Set(
			(content.validations?.children ?? []).flatMap(child => {
				const name = child.attributes.get("table:name")

				return name === undefined ? [] : [name]
			})
		),
		content: entry,
		prefixes,
		styles,
		settings,
		tables: content.tables.map((table, index) => {
			const model = models.get(index)
			const tableStyle = styles.sheetStyle(table.styleName)

			return {
				index,
				id: index,
				name: table.name,
				styleName: table.styleName,
				hidden: !tableStyle.display,
				rightToLeft: tableStyle.rightToLeft,
				tabColor: tableStyle.tabColor,
				cols: model?.cols ?? [],
				merges: model?.merges ?? new Uint32Array(0),
				sections: model?.sections ?? [],
				relationships: model?.relationships.all ?? [],
				view: model?.view ?? DEFAULT_VIEW,
				protection: model?.protection ?? null,
				defaultRowHeight: model?.format.defaultRowHeight ?? Number.NaN,
				defaultColPx: model?.format.defaultColPx ?? Number.NaN,
				truncated: read.some(issue => issue.kind === "repeat" && issue.sheet === table.name && TRUNCATING.has(issue.detail ?? "")),
				rows: table.built.rowCount,
				columns: table.built.columnCount,
				rowProps: table.built.rowProps,
				validationNames: built.validationNames[index] ?? new Map(),
				conditionalFormats: table.conditionalFormats
			}
		}),
		parts: built.parts,
		charts: charts.charts,
		definedNames: [...definedNames],
		protection: built.protection,
		activeTab: built.activeTab,
		issues: read,
		unheld: withCached(content.unheld.result(), (sheet, row, col) =>
			cellPrint(models.get(content.tables.findIndex(table => table.name === sheet)), sharedStrings, row, col)
		)
	})

	return { ok: true, workbook, issues: read }
}

async function isUtf16(odf: OdfPackage, entry: NonNullable<ReturnType<OdfPackage["archive"]["get"]>>): Promise<boolean> {
	for await (const chunk of odf.archive.stream(entry)) {
		return (chunk[0] === 0xfe && chunk[1] === 0xff) || (chunk[0] === 0xff && chunk[1] === 0xfe)
	}

	return false
}
