import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { unzipSync } from "fflate"
import { smlSchemas } from "../../scripts/smlOrder"
import { transitionalSchemas } from "../../scripts/wmlOrder"
import { SCHEMA_ARCHIVE, XMLLINT } from "../fuzz/harness"
import { decodeUtf8, Namespaces, NodeKind, parseXml } from "@filen/office/core/xml"
import { applyMarkupCompatibility, NotWellFormed } from "./mc"

// Schema oracle for written packages: xmllint against the ECMA-376 Transitional schemas (Part 4: WordprocessingML,
// SpreadsheetML, PresentationML, DrawingML, VML, math, shared types, document properties) and the Open Packaging Conventions schemas (Part 2:
// relationships, content types, core properties, with the Dublin Core schemas core properties import). Markup
// Compatibility (Part 3) is applied first (mc.ts), so extension markup no longer hides the errors after it. xmllint
// streams (--stream): a 130 MB part validates in a few MB of memory.

// Part 2 and the Dublin Core schemas: FILEN_OFFICE_OPC_SCHEMAS, else the cache `tsx src/tests/oracles/xsd.ts --fetch` fills.
const OPC_CACHE = fileURLToPath(new URL("../../../node_modules/.cache/filen-office-opc", import.meta.url))

export const OPC_DIRECTORY = process.env["FILEN_OFFICE_OPC_SCHEMAS"] || OPC_CACHE

// SHA-256 pins measured on download (neither publisher lists digests).
const PART2 = {
	url: "https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip",
	name: "ECMA-376-2_5th_edition_december_2021.zip",
	sha256: "1d489dc491168ea1f9e9a59063acc8dd5f02b4ad1d21aa7ec19ba9a58d020c70",
	schemas: "OpenPackagingConventions-XMLSchema.zip",
	schemasSha256: "e5a0a7c1f43ac8b8f66d850f48545c2ead09f6d632bb8539fab79962c7fd55df",
	files: {
		"opc-contentTypes.xsd": "49ec1c03440a9b5590e69acdf92b200fe133697de0b05f43a129fb94d1885026",
		"opc-coreProperties.xsd": "69688ea15f82a870053b9a60c79359063dbcfeec9cdabafabad51a53934bc35b",
		"opc-relationships.xsd": "607ffb6879cf5d5d765bfdfb2548f3f427ea964ddee6d08a15f0dc781749866d"
	}
} as const

// The versions opc-coreProperties.xsd imports by URL.
const DUBLIN_CORE = {
	base: "https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/",
	files: {
		"dc.xsd": "bc1d454db1bb20dfb1867a3fe0cf007775fc4afa33a5df425c12d854f049f1f6",
		"dcterms.xsd": "6328c8b574c166f8ebc28d07231e6ee47121e9791689b70c3afa665f22099fed",
		"dcmitype.xsd": "4980845d0bedcf45e707fa64eb47492ae4f95ac4ae42f5c3c68b58c0bc9e8e49"
	}
} as const

// Every namespace the oracle validates, with the schema that declares it.
const IMPORTS: readonly (readonly [string, string])[] = [
	["http://www.w3.org/XML/1998/namespace", "xml.xsd"],
	["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "wml.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/main", "dml-main.xsd"],
	["http://schemas.openxmlformats.org/spreadsheetml/2006/main", "sml.xsd"],
	["http://schemas.openxmlformats.org/presentationml/2006/main", "pml.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "dml-wordprocessingDrawing.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing", "dml-spreadsheetDrawing.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/picture", "dml-picture.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/chart", "dml-chart.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/chartDrawing", "dml-chartDrawing.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/diagram", "dml-diagram.xsd"],
	["http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas", "dml-lockedCanvas.xsd"],
	["http://schemas.openxmlformats.org/officeDocument/2006/math", "shared-math.xsd"],
	["urn:schemas-microsoft-com:vml", "vml-main.xsd"],
	["urn:schemas-microsoft-com:office:office", "vml-officeDrawing.xsd"],
	["urn:schemas-microsoft-com:office:word", "vml-wordprocessingDrawing.xsd"],
	["urn:schemas-microsoft-com:office:excel", "vml-spreadsheetDrawing.xsd"],
	["urn:schemas-microsoft-com:office:powerpoint", "vml-presentationDrawing.xsd"],
	["http://schemas.openxmlformats.org/officeDocument/2006/extended-properties", "shared-documentPropertiesExtended.xsd"],
	["http://schemas.openxmlformats.org/officeDocument/2006/custom-properties", "shared-documentPropertiesCustom.xsd"],
	["http://schemas.openxmlformats.org/officeDocument/2006/customXml", "shared-customXmlDataProperties.xsd"],
	["http://schemas.openxmlformats.org/officeDocument/2006/bibliography", "shared-bibliography.xsd"],
	["http://schemas.openxmlformats.org/package/2006/relationships", "opc-relationships.xsd"],
	["http://schemas.openxmlformats.org/package/2006/content-types", "opc-contentTypes.xsd"],
	["http://schemas.openxmlformats.org/package/2006/metadata/core-properties", "opc-coreProperties.xsd"]
]

// The XML namespace's attributes as XML 1.0 defines them; the schemas import it without a location or by URL.
const XML_SCHEMA =
	'<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/XML/1998/namespace">' +
	'<xs:attribute name="space"><xs:simpleType><xs:restriction base="xs:NCName"><xs:enumeration value="default"/><xs:enumeration value="preserve"/></xs:restriction></xs:simpleType></xs:attribute>' +
	'<xs:attribute name="lang" type="xs:language"/></xs:schema>'

// Errors about extension markup that is not Ignorable (w14 outside AlternateContent...) say nothing about the
// ECMA schemas; the Open XML SDK validator covers them.
const EXTENSIONS = /\{http:\/\/schemas\.microsoft\.com\/|\{http:\/\/schemas\.openxmlformats\.org\/markup-compatibility\//

// "opc": relationships, content types and core properties (Part 2 schemas).
export type SchemaFamily = "wml" | "sml" | "pml" | "dml" | "opc" | "props"

// The ECMA WordprocessingML parts. Word's own parts under the same prefix (people, commentsExtended, commentsIds,
// commentsExtensible) have Microsoft roots no ECMA schema declares: the Open XML SDK validator covers them.
const WML_KINDS = new Set([
	"document.main",
	"template.main",
	"document.glossary",
	"styles",
	"numbering",
	"settings",
	"webSettings",
	"fontTable",
	"comments",
	"footnotes",
	"endnotes",
	"header",
	"footer"
])
const WML_PREFIX = "application/vnd.openxmlformats-officedocument.wordprocessingml."
const MACRO_MAIN = /^application\/vnd\.ms-word\.(document|template)\.macroEnabled(Template)?\.main\+xml$/
// The ECMA SpreadsheetML parts (ECMA-376 Part 1 §12.3 and §18); Excel's own parts under the same prefix have none.
const SML_KINDS = new Set([
	"sheet.main",
	"template.main",
	"worksheet",
	"chartsheet",
	"dialogsheet",
	"sharedStrings",
	"styles",
	"comments",
	"table",
	"calcChain",
	"externalLink",
	"pivotTable",
	"pivotCacheDefinition",
	"pivotCacheRecords",
	"queryTable",
	"connections",
	"revisionHeaders",
	"revisionLog",
	"userNames",
	"tableSingleCells",
	"sheetMetadata",
	"volatileDependencies"
])
const SML_PREFIX = "application/vnd.openxmlformats-officedocument.spreadsheetml."
const SML_MACRO_MAIN = /^application\/vnd\.ms-excel\.(sheet|template)\.macroEnabled\.main\+xml$/
// The ECMA PresentationML parts (ECMA-376 Part 1 §13.3 and §19). PowerPoint's own parts under the same prefix (modern
// comments and their authors) have Microsoft roots no ECMA schema declares: the Open XML SDK validator covers them.
const PML_KINDS = new Set([
	"presentation.main",
	"slideshow.main",
	"template.main",
	"slide",
	"slideLayout",
	"slideMaster",
	"notesSlide",
	"notesMaster",
	"handoutMaster",
	"comments",
	"commentAuthors",
	"presProps",
	"viewProps",
	"tableStyles",
	"tags",
	"slideUpdateInfo"
])
const PML_PREFIX = "application/vnd.openxmlformats-officedocument.presentationml."
const PML_MACRO_MAIN = /^application\/vnd\.ms-powerpoint\.(presentation|slideshow|template|addin)\.macroEnabled\.main\+xml$/
const DML_TYPES = new Set([
	"application/vnd.openxmlformats-officedocument.drawing+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml",
	"application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml",
	"application/vnd.openxmlformats-officedocument.theme+xml",
	"application/vnd.openxmlformats-officedocument.themeOverride+xml"
])
const PROPS_TYPES = new Set([
	"application/vnd.openxmlformats-package.core-properties+xml",
	"application/vnd.openxmlformats-officedocument.extended-properties+xml",
	"application/vnd.openxmlformats-officedocument.custom-properties+xml",
	"application/vnd.openxmlformats-officedocument.customXmlProperties+xml"
])

// The schema family of a part, or undefined when no ECMA schema declares its root.
export function schemaFamily(part: string, contentType: string | undefined): SchemaFamily | undefined {
	if (part === "[Content_Types].xml") return "opc"
	if (contentType === undefined) return undefined
	if (contentType === "application/vnd.openxmlformats-package.relationships+xml") return "opc"
	if (contentType === "application/vnd.openxmlformats-package.core-properties+xml") return "opc"
	if (PROPS_TYPES.has(contentType)) return "props"
	if (DML_TYPES.has(contentType)) return "dml"
	if (MACRO_MAIN.test(contentType)) return "wml"
	if (SML_MACRO_MAIN.test(contentType)) return "sml"
	if (PML_MACRO_MAIN.test(contentType)) return "pml"
	if (contentType.startsWith(SML_PREFIX) && contentType.endsWith("+xml")) {
		return SML_KINDS.has(contentType.slice(SML_PREFIX.length, -4)) ? "sml" : undefined
	}
	if (contentType.startsWith(WML_PREFIX) && contentType.endsWith("+xml")) {
		return WML_KINDS.has(contentType.slice(WML_PREFIX.length, -4)) ? "wml" : undefined
	}
	if (contentType.startsWith(PML_PREFIX) && contentType.endsWith("+xml")) {
		return PML_KINDS.has(contentType.slice(PML_PREFIX.length, -4)) ? "pml" : undefined
	}

	return undefined
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function pinned(bytes: Uint8Array, expected: string, name: string): Uint8Array {
	if (sha256(bytes) !== expected) throw new Error(`${name} does not match its pinned SHA-256`)

	return bytes
}

function unzipOne(archive: Uint8Array, name: string, expected: string): Uint8Array {
	const entry = unzipSync(archive, { filter: file => file.name === name })[name]

	if (entry === undefined) throw new Error(`${name} is missing from the archive`)

	return pinned(entry, expected, name)
}

// The OPC and Dublin Core schemas by file name, verified against their pins.
function opcSchemas(directory: string): Map<string, Uint8Array> {
	const schemas = unzipOne(
		pinned(new Uint8Array(readFileSync(join(directory, PART2.name))), PART2.sha256, PART2.name),
		PART2.schemas,
		PART2.schemasSha256
	)
	const out = new Map<string, Uint8Array>()

	for (const [name, digest] of Object.entries(PART2.files)) out.set(name, unzipOne(schemas, name, digest))
	for (const [name, digest] of Object.entries(DUBLIN_CORE.files))
		out.set(name, pinned(new Uint8Array(readFileSync(join(directory, name))), digest, name))

	return out
}

async function download(url: string, expected: string): Promise<Uint8Array> {
	const response = await fetch(url)

	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)

	return pinned(new Uint8Array(await response.arrayBuffer()), expected, url)
}

// Fills OPC_CACHE with the pinned Part 2 archive and Dublin Core schemas (what is there and matches is kept).
export async function fetchOpcSchemas(): Promise<void> {
	mkdirSync(OPC_CACHE, { recursive: true })

	const wanted: [string, string, string][] = [
		[PART2.name, PART2.url, PART2.sha256],
		...Object.entries(DUBLIN_CORE.files).map(([name, digest]): [string, string, string] => [name, DUBLIN_CORE.base + name, digest])
	]

	for (const [name, url, digest] of wanted) {
		const path = join(OPC_CACHE, name)

		if (existsSync(path) && sha256(new Uint8Array(readFileSync(path))) === digest) continue

		writeFileSync(path, await download(url, digest))
	}
}

// Why the oracle cannot run here, or undefined when it can.
export function xsdOracleMissing(): string | undefined {
	if (!XMLLINT) return "xmllint is not installed"
	if (!existsSync(SCHEMA_ARCHIVE)) return `no ECMA-376 Part 4 archive at ${SCHEMA_ARCHIVE} (pnpm run generate:wml-order --fetch)`

	return undefined
}

// Why relationships, content types and core properties (Part 2 and Dublin Core) cannot be validated here, or
// undefined when they can; the rest of the oracle runs without them.
export function opcSchemasMissing(): string | undefined {
	const missing = [PART2.name, ...Object.keys(DUBLIN_CORE.files)].filter(name => !existsSync(join(OPC_DIRECTORY, name)))

	return missing.length > 0 ? `no ${missing.join(", ")} in ${OPC_DIRECTORY} (pnpm exec tsx src/tests/oracles/xsd.ts --fetch)` : undefined
}

const OPC_FILES = new Set(["opc-relationships.xsd", "opc-contentTypes.xsd", "opc-coreProperties.xsd"])

// Local copies for every import by URL or without a location.
function localImports(text: string): string {
	return text
		.replace(
			/(<xsd?:import\b[^>]*?namespace="http:\/\/www\.w3\.org\/XML\/1998\/namespace")(?:\s+schemaLocation="[^"]*")?(\s*\/?>)/g,
			'$1 schemaLocation="xml.xsd"$2'
		)
		.replace(
			/schemaLocation="https?:\/\/(?:www\.)?dublincore\.org\/schemas\/xmls\/qdc\/2003\/04\/02\/([a-z]+\.xsd)"/g,
			'schemaLocation="$1"'
		)
}

// One xmllint run over a batch may take this long; longer fails the run.
const TOOL_TIMEOUT_MS = 600_000
// Documents per tool run: bounds the scratch disk use and the command line.
const BATCH = 200
// Larger documents stream through xmllint: a tree of a 130 MB part takes 1.6 GB.
const STREAM_BYTES = 16 << 20

function run(tool: string, args: readonly string[], report: string): void {
	const output = openSync(report, "w")

	try {
		const result = spawnSync(tool, args, { stdio: ["ignore", "ignore", output], timeout: TOOL_TIMEOUT_MS, killSignal: "SIGKILL" })

		if (result.error !== undefined || result.signal !== null)
			throw new Error(`${tool} failed: ${result.error?.message ?? `killed by ${result.signal}`}`)
	} finally {
		closeSync(output)
	}
}

export const NOT_WELL_FORMED = "not well-formed XML"

export class XsdOracle {
	readonly directory: string
	// Whether relationships, content types and core properties are validated (opcSchemasMissing).
	readonly opc: boolean
	private readonly schema: string

	constructor() {
		const missing = xsdOracleMissing()

		if (missing !== undefined) throw new Error(`The schema oracle cannot run: ${missing}`)

		this.directory = mkdtempSync(join(tmpdir(), "filen-office-xsd-"))

		const schemas = join(this.directory, "schemas")

		mkdirSync(schemas)

		const decoder = new TextDecoder()
		this.opc = opcSchemasMissing() === undefined

		const transitional = transitionalSchemas(new Uint8Array(readFileSync(SCHEMA_ARCHIVE)))

		smlSchemas(transitional)

		const files = new Map([...transitional, ...(this.opc ? opcSchemas(OPC_DIRECTORY) : [])])

		for (const [name, bytes] of files) writeFileSync(join(schemas, name), localImports(decoder.decode(bytes)))

		writeFileSync(join(schemas, "xml.xsd"), XML_SCHEMA)

		this.schema = join(schemas, "oracle.xsd")
		writeFileSync(
			this.schema,
			'<?xml version="1.0"?>\n<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:filen:office:oracle">\n' +
				IMPORTS.filter(([, location]) => this.opc || !OPC_FILES.has(location))
					.map(([namespace, location]) => `\t<xsd:import namespace="${namespace}" schemaLocation="${location}"/>\n`)
					.join("") +
				"</xsd:schema>\n"
		)
	}

	// Validity errors of each document by message (line numbers and xmllint's list of expected elements left
	// out), counted; NOT_WELL_FORMED when the XML does not parse.
	validate(documents: readonly Uint8Array[]): Map<string, number>[] {
		const out: Map<string, number>[] = []

		for (let start = 0; start < documents.length; start += BATCH) out.push(...this.batch(documents.slice(start, start + BATCH)))

		return out
	}

	dispose(): void {
		rmSync(this.directory, { recursive: true, force: true })
	}

	private lint(args: readonly string[], outputs: Map<string, number>, results: Map<string, number>[], report: string): void {
		run("xmllint", ["--nonet", "--schema", this.schema, ...args], report)

		for (const line of readFileSync(report, "utf8").split("\n")) {
			// --stream reports "<file> : failed to parse", tree mode "<file>:<line>: parser error : ...".
			const failed = / : failed to parse$|:\d+: (?:parser|namespace) error : /.exec(line)

			if (failed !== null) {
				const index = outputs.get(line.slice(0, failed.index))

				if (index === undefined) throw new Error(`Unattributed xmllint report line: ${line}`)

				results[index]?.set(NOT_WELL_FORMED, 1)
				continue
			}

			if (!line.includes("validity error") || EXTENSIONS.test(line)) continue

			const match = /^(.*?\.xml):\d+: (?:element [^:]+: )?/.exec(line)
			const index = match === null ? undefined : outputs.get(match[1] as string)

			if (match === null || index === undefined) throw new Error(`Unattributed xmllint report line: ${line}`)

			// Tree mode names the element first, --stream does not.
			const message = line.slice(match[0].length).replace(/ Expected is .*$/, "")
			const errors = results[index] as Map<string, number>

			errors.set(message, (errors.get(message) ?? 0) + 1)
		}
	}

	private batch(documents: readonly Uint8Array[]): Map<string, number>[] {
		const work = mkdtempSync(join(this.directory, "run-"))
		const results = documents.map(() => new Map<string, number>())
		const outputs = new Map<string, number>()

		try {
			documents.forEach((bytes, index) => {
				const output = join(work, `${index}.xml`)
				const fd = openSync(output, "w")

				try {
					applyMarkupCompatibility(bytes, fd)
					outputs.set(output, index)
				} catch (error) {
					if (!(error instanceof NotWellFormed)) throw error

					results[index]?.set(NOT_WELL_FORMED, 1)
				} finally {
					closeSync(fd)
				}
			})

			const small: string[] = []
			const large: string[] = []

			for (const [output, index] of outputs) ((documents[index]?.length ?? 0) > STREAM_BYTES ? large : small).push(output)

			// A tree-mode run compiles the schemas once for all its files; --stream compiles them per file.
			if (small.length > 0) this.lint(["--noout", ...small], outputs, results, join(work, "report.txt"))
			if (large.length > 0) this.lint(["--noout", "--stream", ...large], outputs, results, join(work, "stream.txt"))

			return results
		} finally {
			rmSync(work, { recursive: true, force: true })
		}
	}
}

const REQUIRED = /^Schemas validity error : Element '\{([^}]*)\}([\w.-]+)': The attribute '\{([^}]*)\}([\w.-]+)' is required but missing\.$/

// Elements {uri}local of `source` without the attribute {attributeUri}attribute.
function lacking(source: Uint8Array, uri: string, local: string, attributeUri: string, attribute: string): number {
	let document

	try {
		document = parseXml(source)
	} catch {
		return 0
	}

	const namespaces = new Namespaces(document)
	let count = 0

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element || document.localName(node) !== local || namespaces.elementUri(node) !== uri) continue
		if (namespaces.attribute(node, attributeUri, attribute) === undefined) count++
	}

	return count
}

// Errors `after` has more of than `before`, as "message (before -> after)". `source`: the part's source XML,
// which the exemptions below look at (without it, they are not applied).
export function newValidityErrors(before: Map<string, number>, after: Map<string, number>, source?: Uint8Array): string[] {
	const nilText = source !== undefined && decodeUtf8(source).includes('xsi:nil="true"')
	const out: string[] = []

	for (const [message, count] of after) {
		const was = before.get(message) ?? 0

		// A value the source already had wrong is copied with the run it is in (a split repeats it).
		if (was > 0 && message.includes("[facet ")) continue
		// So is an element the source part already has where the schema allows none.
		if (was > 0 && message.endsWith("This element is not expected.")) continue
		// The source's own xsi:nil on copied text, reported once an earlier error no longer hides it.
		if (nilText && message.includes("is not 'nillable'")) continue
		if (count <= was) continue

		// A required attribute the source's elements already lack, reported once an earlier error in their parent
		// (which xmllint stops at) is gone: the writer put the parent's children in schema order.
		const required = REQUIRED.exec(message)

		if (
			required !== null &&
			source !== undefined &&
			lacking(source, required[1] ?? "", required[2] ?? "", required[3] ?? "", required[4] ?? "") > 0
		)
			continue

		out.push(`${message} (${was} -> ${count})`)
	}

	return out
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--fetch")) await fetchOpcSchemas()
