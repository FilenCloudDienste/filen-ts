import { CfbError, CfbFile, isCompoundFile } from "../../cfb/index"
import { relationshipKind } from "../../docx/package"
import { parseTheme, SCHEME_SLOTS } from "../../docx/theme/theme"
import { isEncryptedContainer } from "../../encryption/index"
import { OpcError, OpcPackage, ZipError, partKey, type ByteSource, type Relationships, type ZipOpenOptions } from "../../opc/index"
import { coreTitle } from "../../opc/coreTitle"
import type { SheetKind, SheetOpenFailure } from "../../sheet/protocol"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { parseXml, parseXmlSliced, XmlError, type XmlDocument } from "../../xml/index"
import { ChangeLog } from "../model/changes"
import { SharedStrings } from "../model/sharedStrings"
import type { XlsxDefinedName, XlsxSheetEntry, XlsxTheme, XlsxVariant } from "../model/types"
import { XlsxWorkbook, readError } from "../model/workbook"
import { XlsxReadError } from "../read/errors"
import { DEFAULT_XLSX_LIMITS, type XlsxLimits } from "../read/limits"
import { countElements } from "../read/scan"
import { readSharedStrings } from "../read/sharedStrings"
import { readStyles } from "../read/styles"
import { readWorkbook, sourcedName } from "../read/workbook"
import { SHEET_CONTENT_TYPES } from "../write/namespaces"
import { XlsxParts } from "./parts"

// Why a file could not be opened as a workbook at all.
export type XlsxOpenFailure =
	// An OLE2 compound file holding an encrypted OOXML package: unlock it (dom/encryption) and open the plaintext.
	| "encrypted"
	// A legacy binary workbook (.xls, .xlt) under any name.
	| "legacyBinary"
	// Some other OLE2 compound file.
	| "compoundFile"
	| "notZip"
	| "invalidPackage"
	// A valid package that is not a workbook (a document, a presentation...).
	| "notSpreadsheet"
	// A workbook whose main part is not SpreadsheetML (.xlsb).
	| "unsupported"
	// The workbook, styles or shared strings part does not read.
	| "malformed"
	| "tooLarge"
	| "aborted"
	// An internal error: `message` names it.
	| "failed"

export type XlsxOpenResult =
	| { readonly ok: true; readonly workbook: XlsxWorkbook }
	| { readonly ok: false; readonly reason: XlsxOpenFailure; readonly message: string }

export interface XlsxOpenOptions extends ZipOpenOptions {
	// Host turns while parts inflate and parse (the in-thread host); one clock across the whole open.
	readonly slicing?: Slicing
	readonly readLimits?: Partial<XlsxLimits>
	readonly signal?: { readonly aborted: boolean }
}

// The protocol's open failure for a reader failure.
export function sheetOpenFailure(reason: XlsxOpenFailure): SheetOpenFailure {
	switch (reason) {
		case "tooLarge":
			return "tooLarge"
		case "unsupported":
		case "legacyBinary":
			return "unsupported"
		case "failed":
		case "aborted":
			return "failed"
		default:
			return "malformed"
	}
}

const MAIN_CONTENT_TYPES = new Map<string, XlsxVariant>([
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "xlsx"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml", "xltx"],
	["application/vnd.ms-excel.sheet.macroenabled.main+xml", "xlsm"],
	["application/vnd.ms-excel.template.macroenabled.main+xml", "xltm"]
])

const SHEET_KINDS: ReadonlyMap<string, SheetKind> = new Map([
	["worksheet", "worksheet"],
	["chartsheet", "chartsheet"],
	["dialogsheet", "dialogsheet"],
	["xlMacrosheet", "macrosheet"],
	["xlIntlMacrosheet", "macrosheet"]
])

const SIGNATURE_ORIGIN = "http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin"
const SIGNATURE = "http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature"
// The main streams of Excel binary files (5.0 and later; 95 and before).
const LEGACY_STREAMS = ["Workbook", "Book"]

function isAborted(signal: { readonly aborted: boolean } | undefined): boolean {
	return signal?.aborted === true
}

function failure(reason: XlsxOpenFailure, message: string): XlsxOpenResult {
	return { ok: false, reason, message }
}

// Opens a workbook package: content types, relationships, workbook.xml, styles, shared strings and theme. No
// sheet is parsed (XlsxWorkbook.load). Never throws: every failure is a typed result.
export async function openXlsx(source: ByteSource, options: XlsxOpenOptions = {}): Promise<XlsxOpenResult> {
	try {
		return await open(source, options)
	} catch (error) {
		const typed = readError(error, "")

		if (typed instanceof XlsxReadError) {
			switch (typed.code) {
				case "tooLarge":
					return failure("tooLarge", typed.message)
				case "aborted":
					return failure("aborted", typed.message)
				case "unsupported":
					return failure("unsupported", typed.message)
				default:
					return failure("malformed", typed.message)
			}
		}

		if (error instanceof CfbError) return failure("compoundFile", error.message)
		if (options.signal?.aborted === true) return failure("aborted", "Opening was aborted")

		return failure("failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
	}
}

async function open(source: ByteSource, options: XlsxOpenOptions): Promise<XlsxOpenResult> {
	const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...options.readLimits }
	const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
	const signal = options.signal

	if (source.size >= 8 && isCompoundFile(await source.read(0, 8))) {
		const kind = await compoundFileKind(source)

		return failure(
			kind,
			kind === "encrypted" ? "Password-protected workbook" : kind === "legacyBinary" ? "Legacy binary workbook" : "OLE2 compound file"
		)
	}

	let opc: OpcPackage

	try {
		opc = await OpcPackage.open(source, options)
	} catch (error) {
		if (error instanceof ZipError) {
			switch (error.code) {
				case "notZip":
					return failure("notZip", error.message)
				case "tooManyEntries":
				case "tooLarge":
					return failure("tooLarge", error.message)
				default:
					return failure("invalidPackage", error.message)
			}
		}

		if (error instanceof OpcError) return failure("invalidPackage", error.message)

		throw error
	}

	let contentTypes
	let packageRelationships: Relationships

	try {
		;[contentTypes, packageRelationships] = await Promise.all([opc.contentTypes(), opc.relationships("")])
	} catch (error) {
		if (error instanceof OpcError || error instanceof XmlError || error instanceof ZipError)
			return failure("invalidPackage", error.message)

		throw error
	}

	const main = packageRelationships.all.find(
		relationship => !relationship.external && relationshipKind(relationship.type) === "officeDocument"
	)

	if (main?.partName === undefined || !opc.has(main.partName)) return failure("notSpreadsheet", "The package has no main part")

	const workbookPart = opc.entry(main.partName)?.name ?? main.partName
	const contentType = contentTypes.typeOf(workbookPart)?.toLowerCase()
	let variant = contentType === undefined ? undefined : MAIN_CONTENT_TYPES.get(contentType)

	if (variant === undefined && contentType !== undefined) {
		if (contentType.includes("ms-excel.sheet.binary")) return failure("unsupported", "A binary workbook (.xlsb)")
		if (
			contentType.includes("wordprocessingml") ||
			contentType.includes("presentationml") ||
			contentType.includes("ms-word") ||
			contentType.includes("ms-powerpoint")
		) {
			return failure("notSpreadsheet", `The main part is ${contentType}`)
		}
	}

	const parts = new XlsxParts(opc, contentTypes)
	const workbookRelationships = await parts.relationships(workbookPart)
	const workbookDocument = await readXml(parts, workbookPart, limits, clock)
	const facts = readWorkbook(workbookDocument, workbookPart, limits)

	if (isAborted(signal)) return failure("aborted", "Opening was aborted")

	const related = (kind: string): string | undefined =>
		workbookRelationships.all.find(
			relationship =>
				!relationship.external &&
				relationship.partName !== undefined &&
				relationshipKind(relationship.type) === kind &&
				opc.has(relationship.partName)
		)?.partName
	const stylesPart = related("styles")
	const stringsPart = related("sharedStrings")
	const themePart = related("theme")
	const [stylesDocument, sharedStrings, theme] = await Promise.all([
		stylesPart === undefined ? null : readXml(parts, stylesPart, limits, clock),
		stringsPart === undefined ? SharedStrings.empty(() => null) : readStrings(parts, stringsPart, limits, clock),
		themePart === undefined ? null : readTheme(parts, themePart, limits, clock)
	])
	const styles = readStyles(stylesDocument, stylesPart ?? "", limits)

	if (isAborted(signal)) return failure("aborted", "Opening was aborted")

	const macros = workbookRelationships.all.some(relationship => relationshipKind(relationship.type) === "vbaProject")

	variant ??= "xlsx"

	if (macros && variant === "xlsx") variant = "xlsm"
	if (macros && variant === "xltx") variant = "xltm"

	// A sheet's part is its own and a sheet part: one another sheet already has, or a part of another kind
	// (the workbook, styles, shared strings, theme), would take the sheet's edits and lose them on save. Such a
	// sheet is left without a part: it does not load, which leaves the workbook view-only.
	const claimed = new Set([workbookPart, stylesPart, stringsPart, themePart].flatMap(part => (part === undefined ? [] : [partKey(part)])))
	const sheets: XlsxSheetEntry[] = facts.sheets.map((record, index) => {
		const relationship = record.relationshipId === "" ? undefined : workbookRelationships.byId(record.relationshipId)
		const kind = relationship === undefined ? undefined : SHEET_KINDS.get(relationshipKind(relationship.type) ?? "")
		const target = relationship === undefined || relationship.external ? "" : (relationship.partName ?? "")
		let part = target === "" ? "" : (opc.entry(target)?.name ?? target)

		if (part !== "") {
			const key = partKey(part)
			const type = contentTypes.typeOf(part)?.toLowerCase()

			if (claimed.has(key) || (opc.has(part) && (type === undefined || !SHEET_CONTENT_TYPES.has(type)))) part = ""

			claimed.add(key)
		}

		return {
			id: index,
			name: record.name,
			state: record.state,
			kind: kind ?? "worksheet",
			sheetId: record.sheetId,
			relationshipId: record.relationshipId,
			part,
			model: null
		}
	})
	const definedNames: XlsxDefinedName[] = facts.names.map(record =>
		sourcedName(
			record,
			record.localSheetId >= 0 && record.localSheetId < sheets.length ? (sheets[record.localSheetId]?.id ?? null) : null
		)
	)
	const strict =
		facts.strict ||
		main.type.startsWith("http://purl.oclc.org/ooxml/") ||
		workbookRelationships.all.some(relationship => relationship.type.startsWith("http://purl.oclc.org/ooxml/"))

	const title = await coreTitle(opc)

	return {
		ok: true,
		workbook: new XlsxWorkbook({
			variant,
			strict,
			parts,
			workbookPart,
			workbookSections: facts.sections,
			sheets,
			definedNames,
			styles,
			sharedStrings,
			theme,
			date1904: facts.date1904,
			calc: facts.calc,
			protection: facts.protection,
			fileSharing: facts.fileSharing,
			activeTab: Math.min(facts.activeTab, Math.max(0, sheets.length - 1)),
			changes: new ChangeLog(name => parts.loadedRelationships(name)),
			limits,
			macros,
			signatures: await signatureCount(opc, packageRelationships),
			...(title === undefined ? {} : { title })
		})
	}
}

// A meta part (workbook, styles, theme) as a tree: its elements are counted first, so a flood of tiny ones is
// refused before a node is built for each.
async function readXml(parts: XlsxParts, part: string, limits: XlsxLimits, clock: SliceClock | undefined): Promise<XmlDocument> {
	const entry = parts.get(part)?.source

	if (entry !== null && entry !== undefined && entry.uncompressedSize > limits.maxMetaPart)
		throw new XlsxReadError("tooLarge", "The part is too large", part)

	try {
		const bytes = await parts.read(part, clock)

		await countElements(bytes, part, limits.maxMetaElements, clock)

		return clock === undefined ? parseXml(bytes) : await parseXmlSliced(bytes, clock)
	} catch (error) {
		throw readError(error, part)
	}
}

async function readStrings(parts: XlsxParts, part: string, limits: XlsxLimits, clock: SliceClock | undefined): Promise<SharedStrings> {
	const entry = parts.get(part)?.source

	if (entry !== null && entry !== undefined && entry.uncompressedSize > limits.maxSharedStringsPart) {
		throw new XlsxReadError("tooLarge", "The shared strings part is too large", part)
	}

	try {
		return await readSharedStrings(await parts.read(part, clock), part, limits, clock)
	} catch (error) {
		throw readError(error, part)
	}
}

// The theme's scheme colours and fonts; a theme that does not read is no theme (it only colours the display).
async function readTheme(parts: XlsxParts, part: string, limits: XlsxLimits, clock: SliceClock | undefined): Promise<XlsxTheme | null> {
	let document: XmlDocument

	try {
		document = await readXml(parts, part, limits, clock)
	} catch (error) {
		if (error instanceof XlsxReadError && error.code !== "aborted") return null

		throw error
	}

	const theme = parseTheme(document)

	return {
		colors: SCHEME_SLOTS.map(slot => {
			const hex = theme.colors.get(slot)

			return hex === undefined ? 0 : Number.parseInt(hex, 16) || 0
		}),
		majorFont: theme.major.latin,
		minorFont: theme.minor.latin
	}
}

async function signatureCount(opc: OpcPackage, packageRelationships: Relationships): Promise<number> {
	let count = 0

	for (const origin of packageRelationships.byType(SIGNATURE_ORIGIN)) {
		if (origin.external || origin.partName === undefined || !opc.has(origin.partName)) continue

		try {
			const relationships = await opc.relationships(origin.partName)

			count += relationships.all.filter(relationship => relationship.type === SIGNATURE && !relationship.external).length
		} catch (error) {
			if (!(error instanceof OpcError || error instanceof XmlError || error instanceof ZipError)) throw error

			count++
		}
	}

	return count
}

// An encrypted OOXML package or a legacy binary workbook, by the streams at the compound file's root.
async function compoundFileKind(source: ByteSource): Promise<"encrypted" | "legacyBinary" | "compoundFile"> {
	let cfb: CfbFile

	try {
		cfb = await CfbFile.open(source)
	} catch (error) {
		if (error instanceof CfbError) return "compoundFile"

		throw error
	}

	if (isEncryptedContainer(cfb)) return "encrypted"
	if (LEGACY_STREAMS.some(name => cfb.entry([name])?.kind === "stream")) return "legacyBinary"

	return "compoundFile"
}
