import { OpcError, ZipError } from "../../opc/errors"
import type { ContentTypes } from "../../opc/contentTypes"
import type { OpcPackage } from "../../opc/package"
import type { NumFmtLocale } from "../../sheet/numfmt/locale"
import type { SheetDocumentProperties, SheetId } from "../../sheet/protocol"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { XmlError } from "../../xml/index"
import type { XlsxParts } from "../package/parts"
import { XlsxReadError } from "../read/errors"
import { XlsxReadBudget, type XlsxLimits } from "../read/limits"
import { readWorksheet, type XlsxSheet } from "../read/worksheet"
import type { ChangeLog } from "./changes"
import type { SharedStrings } from "./sharedStrings"
import type { StyleTable } from "./styles"
import type {
	XlsxCalcProperties,
	XlsxDefinedName,
	XlsxFileSharing,
	XlsxSection,
	XlsxSheetEntry,
	XlsxSheetModel,
	XlsxTheme,
	XlsxVariant,
	XlsxWorkbookModel,
	XlsxWorkbookProtection
} from "./types"

// Reads one sheet of a source whose sheets are not SpreadsheetML parts (an OpenDocument spreadsheet, whose sheets
// are all in one stream): XlsxWorkbook.load asks it instead of parsing the sheet's part.
export type XlsxSheetLoader = (
	entry: XlsxSheetEntry,
	clock: SliceClock | undefined,
	signal: { readonly aborted: boolean } | undefined
) => Promise<XlsxSheetModel>

// The file format the workbook was read from: "ods" is an OpenDocument spreadsheet read into this model.
export type XlsxSourceFormat = "xlsx" | "ods"

export interface XlsxWorkbookInit {
	readonly format?: XlsxSourceFormat
	readonly loader?: XlsxSheetLoader
	// The language data a number format's [$-xxxx] tag names, where the source carries languages (OpenDocument data
	// styles): what the formatter shows for each.
	readonly localeFor?: (lcid: number) => NumFmtLocale | undefined
	// General shown as LibreOffice's "Standard" with this precision (negative: unlimited), for an OpenDocument source.
	readonly standardPrecision?: number
	readonly variant: XlsxVariant
	readonly strict: boolean
	readonly parts: XlsxParts
	readonly workbookPart: string
	readonly workbookSections: readonly XlsxSection[]
	readonly sheets: XlsxSheetEntry[]
	readonly definedNames: XlsxDefinedName[]
	readonly styles: StyleTable
	readonly sharedStrings: SharedStrings
	readonly theme: XlsxTheme | null
	readonly date1904: boolean
	readonly calc: XlsxCalcProperties
	readonly protection: XlsxWorkbookProtection | null
	readonly fileSharing: XlsxFileSharing | null
	readonly activeTab: number
	readonly changes: ChangeLog
	readonly limits: XlsxLimits
	readonly macros: boolean
	readonly signatures: number
	// The workbook's own title (docProps/core.xml, or an OpenDocument spreadsheet's meta.xml).
	readonly title?: string
	// Its author, subject and keywords (docProps/core.xml).
	readonly properties?: SheetDocumentProperties
}

export class XlsxWorkbook implements XlsxWorkbookModel {
	readonly format: XlsxSourceFormat
	readonly localeFor: ((lcid: number) => NumFmtLocale | undefined) | undefined
	readonly standardPrecision: number | undefined
	readonly variant: XlsxVariant
	readonly strict: boolean
	readonly parts: XlsxParts
	readonly workbookPart: string
	readonly workbookSections: readonly XlsxSection[]
	readonly sheets: XlsxSheetEntry[]
	readonly definedNames: XlsxDefinedName[]
	readonly styles: StyleTable
	readonly sharedStrings: SharedStrings
	readonly theme: XlsxTheme | null
	readonly date1904: boolean
	calc: XlsxCalcProperties
	protection: XlsxWorkbookProtection | null
	fileSharing: XlsxFileSharing | null
	activeTab: number
	readonly changes: ChangeLog
	readonly limits: XlsxLimits
	// A VBA project is in the package (copied byte for byte, never run).
	readonly macros: boolean
	// Signatures in the package's digital signature origin: an edit breaks them.
	readonly signatures: number
	// The workbook's own title (docProps/core.xml, or an OpenDocument spreadsheet's meta.xml dc:title).
	readonly title: string | undefined
	readonly properties: SheetDocumentProperties | undefined
	private readonly loads = new Map<SheetId, Promise<XlsxSheetModel>>()
	// Why a sheet could not be read: asked for again, it fails at once rather than being inflated and parsed again.
	private readonly failures = new Map<SheetId, XlsxReadError>()
	private nextId: number
	// What the parsed sheets hold together, against the limits.
	private readonly budget: XlsxReadBudget
	private readonly loader: XlsxSheetLoader | undefined

	constructor(init: XlsxWorkbookInit) {
		this.format = init.format ?? "xlsx"
		this.loader = init.loader
		this.localeFor = init.localeFor
		this.standardPrecision = init.standardPrecision
		this.variant = init.variant
		this.strict = init.strict
		this.parts = init.parts
		this.workbookPart = init.workbookPart
		this.workbookSections = init.workbookSections
		this.sheets = init.sheets
		this.definedNames = init.definedNames
		this.styles = init.styles
		this.sharedStrings = init.sharedStrings
		this.theme = init.theme
		this.date1904 = init.date1904
		this.calc = init.calc
		this.protection = init.protection
		this.fileSharing = init.fileSharing
		this.activeTab = init.activeTab
		this.changes = init.changes
		this.limits = init.limits
		this.macros = init.macros
		this.signatures = init.signatures
		this.title = init.title
		this.properties = init.properties
		this.nextId = init.sheets.reduce((highest, sheet) => Math.max(highest, sheet.id + 1), 0)
		this.budget = new XlsxReadBudget(init.limits, init.workbookSections.length)
	}

	get opc(): OpcPackage {
		return this.parts.opc
	}

	get contentTypes(): ContentTypes {
		return this.parts.contentTypes
	}

	// An id for a new sheet: never one the session used before.
	allocateSheetId(): SheetId {
		return this.nextId++
	}

	sheet(id: SheetId): XlsxSheetEntry | undefined {
		return this.sheets.find(sheet => sheet.id === id)
	}

	loaded(id: SheetId): XlsxSheetModel | null {
		return this.sheet(id)?.model ?? null
	}

	load(id: SheetId, slicing?: Slicing, signal?: { readonly aborted: boolean }): Promise<XlsxSheetModel> {
		const entry = this.sheet(id)

		if (entry === undefined) return Promise.reject(new XlsxReadError("missingPart", `No sheet ${id}`))
		if (entry.model !== null) return Promise.resolve(entry.model)

		const failure = this.failures.get(id)

		if (failure !== undefined) return Promise.reject(failure)

		let promise = this.loads.get(id)

		if (promise === undefined) {
			promise = this.parse(entry, slicing === undefined ? undefined : sliceClock(slicing), signal)
			this.loads.set(id, promise)
			promise.then(
				() => this.loads.delete(id),
				(error: unknown) => {
					this.loads.delete(id)

					if (error instanceof XlsxReadError && error.code !== "aborted") this.failures.set(id, error)
				}
			)
		}

		return promise
	}

	// Parses `first`, then every other sheet in workbook order, one at a time on one slice clock (idle slices).
	// A sheet that cannot be read is reported to `onError` and stays unparsed.
	async loadAll(
		first: SheetId,
		slicing?: Slicing,
		onReady?: (sheet: XlsxSheetModel) => void,
		onError?: (id: SheetId, error: XlsxReadError) => void,
		signal?: { readonly aborted: boolean }
	): Promise<void> {
		const clock = slicing === undefined ? undefined : sliceClock(slicing)
		const order = [first, ...this.sheets.map(sheet => sheet.id).filter(id => id !== first)]

		for (const id of order) {
			if (signal?.aborted === true) return
			if (this.sheet(id)?.model !== null) continue

			try {
				const model = await this.load(id, clock, signal)

				onReady?.(model)
			} catch (error) {
				if (!(error instanceof XlsxReadError)) throw error
				if (error.code === "aborted") return

				onError?.(id, error)
			}
		}
	}

	private async parse(
		entry: XlsxSheetEntry,
		clock: SliceClock | undefined,
		signal: { readonly aborted: boolean } | undefined
	): Promise<XlsxSheetModel> {
		const part = entry.part

		if (this.loader !== undefined) {
			try {
				const model = await this.loader(entry, clock, signal)

				entry.model = model

				return model
			} catch (error) {
				throw readError(error, part)
			}
		}

		const source = part === "" ? undefined : this.parts.get(part)

		if (source?.source === undefined || source.source === null) {
			throw new XlsxReadError("missingPart", `The part of sheet "${entry.name}" is missing`, part)
		}

		if (source.source.uncompressedSize > this.limits.maxSheetPart)
			throw new XlsxReadError("tooLarge", "The sheet part is too large", part)

		try {
			const [bytes, relationships] = await Promise.all([this.parts.read(source.name, clock), this.parts.relationships(source.name)])

			if (signal?.aborted === true) throw new XlsxReadError("aborted", "Reading was aborted", part)

			const sheet: XlsxSheet = await readWorksheet(bytes, {
				id: entry.id,
				part: source.name,
				relationships,
				limits: this.limits,
				sharedStrings: this.sharedStrings.sourceLength,
				cellBudget: this.limits.maxCells,
				budget: this.budget,
				clock,
				signal
			})

			entry.model = sheet

			return sheet
		} catch (error) {
			throw readError(error, part)
		}
	}
}

// Any failure reading a part as an XlsxReadError; anything else is a bug and passes through.
export function readError(error: unknown, part: string): unknown {
	if (error instanceof XlsxReadError) return error
	if (error instanceof XmlError) return new XlsxReadError("malformed", error.message, part, error.offset)
	if (error instanceof ZipError) return new XlsxReadError(error.code === "tooLarge" ? "tooLarge" : "malformed", error.message, part)
	if (error instanceof OpcError) return new XlsxReadError(error.code === "missingPart" ? "missingPart" : "malformed", error.message, part)

	return error
}
