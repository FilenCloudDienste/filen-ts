import { strFromU8, unzipSync } from "fflate"
import { bytesSource } from "@filen/office/core/opc"
import { openOds, type OdsOpenResult } from "../core/ods/open"
import { XlsxDocument } from "../core/xlsx/edit/document"
import { RenderStyleTable } from "../core/sheet/session"
import { parseCsv } from "./oracles/sheet/libreOffice"
import { buildZip, text } from "./zipBuilder"

// Small ODS packages written by hand, opened into the xlsx model.

// The corpus's encrypted spreadsheets, in name order: AES-256-CBC (ODF 1.2+) and the legacy Blowfish CFB of
// OpenOffice.org 1.x-3.x. Neither opens without its password.
export const ODS_ENCRYPTED: readonly string[] = ["lo__password.ods", "lo__passwordOld.ods"]

export const ODS_NS = [
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
	'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
	'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
	'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
	'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
	'xmlns:xlink="http://www.w3.org/1999/xlink"',
	'xmlns:dc="http://purl.org/dc/elements/1.1/"',
	'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"',
	'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"',
	'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"',
	'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"',
	'xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"'
].join(" ")

export interface OdsParts {
	// office:automatic-styles of content.xml.
	readonly automatic?: string
	// office:spreadsheet's content.
	readonly body: string
	// office:styles of styles.xml.
	readonly styles?: string
	// office:settings' content of settings.xml.
	readonly settings?: string
	// The root's namespace declarations, instead of ODS_NS.
	readonly namespaces?: string
	readonly mediaType?: string
	readonly extra?: readonly { readonly name: string; readonly data: Uint8Array }[]
	// More manifest:file-entry elements.
	readonly manifestEntries?: string
}

export function odsBytes(parts: OdsParts): Uint8Array {
	const namespaces = parts.namespaces ?? ODS_NS
	const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${namespaces} office:version="1.3"><office:automatic-styles>${parts.automatic ?? ""}</office:automatic-styles><office:body><office:spreadsheet>${parts.body}</office:spreadsheet></office:body></office:document-content>`
	const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODS_NS} office:version="1.3"><office:styles>${parts.styles ?? '<style:style style:name="Default" style:family="table-cell"/>'}</office:styles></office:document-styles>`
	const mediaType = parts.mediaType ?? "application/vnd.oasis.opendocument.spreadsheet"
	const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>${parts.settings === undefined ? "" : '<manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>'}${(parts.extra ?? []).map(entry => `<manifest:file-entry manifest:full-path="${entry.name}" manifest:media-type=""/>`).join("")}${parts.manifestEntries ?? ""}</manifest:manifest>`

	return buildZip([
		{ name: "mimetype", data: text(mediaType), method: 0 },
		{ name: "content.xml", data: text(content) },
		{ name: "styles.xml", data: text(styles) },
		...(parts.settings === undefined
			? []
			: [
					{
						name: "settings.xml",
						data: text(
							`<?xml version="1.0" encoding="UTF-8"?><office:document-settings ${ODS_NS} office:version="1.3"><office:settings>${parts.settings}</office:settings></office:document-settings>`
						)
					}
				]),
		...(parts.extra ?? []),
		{ name: "META-INF/manifest.xml", data: text(manifest) }
	])
}

// One table:table of `rows` (table:table-row elements) and optional columns.
export function table(name: string, rows: string, columns = "", attributes = ""): string {
	return `<table:table table:name="${name}"${attributes}>${columns}${rows}</table:table>`
}

export async function openOdsFixture(parts: OdsParts): Promise<Extract<OdsOpenResult, { ok: true }>> {
	const result = await openOds(bytesSource(odsBytes(parts)))

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result
}

export function odsDocument(result: Extract<OdsOpenResult, { ok: true }>): XlsxDocument {
	return new XlsxDocument(result.workbook, new RenderStyleTable(), { kind: "ods" })
}

// Each sheet's cells as the CSV shows them (as shown), trailing empty fields and rows dropped.
export function shownRows(document: XlsxDocument, sheet: number): string[][] {
	const csv = document.csv(sheet)

	if (csv !== null && !(csv instanceof Uint8Array)) throw new Error(`csv refused: ${csv.reason}`)

	return trimmedRows(csv === null ? [] : parseCsv(new TextDecoder().decode(csv)))
}

// Rows without their trailing empty fields, and without trailing empty rows.
export function trimmedRows(rows: readonly (readonly string[])[]): string[][] {
	const out = rows.map(row => {
		const copy = [...row]

		while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop()

		return copy
	})

	while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop()

	return out
}

// A saved package's content.xml as text (empty when it has none).
export function odsContent(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["content.xml"] ?? new Uint8Array(0))
}

// A manifest entry marking `path` encrypted (ODF 1.3 Part 2 §4.8), as LibreOffice writes a password-protected file.
export function encryptedEntry(path: string): string {
	return `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="text/xml" manifest:size="10"><manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AA=="><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AA=="/><manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="1024" manifest:salt="AA=="/></manifest:encryption-data></manifest:file-entry>`
}
