import { bytesSource } from "@filen/office/core/opc"
import { openOdp, type OdpOpenOptions, type OdpParts } from "../core/odp/read/document"
import type { Deck, ShapeNode, SlideNode } from "../core/presentation/model"
import { buildZip, text } from "./zipBuilder"

// Small ODP packages written by hand.

export const ODP_NS = [
	'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
	'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
	'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
	'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
	'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
	'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
	'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
	'xmlns:xlink="http://www.w3.org/1999/xlink"',
	'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
	'xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0"',
	'xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0"',
	'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"',
	'xmlns:dom="http://www.w3.org/2001/xml-events"',
	'xmlns:officeooo="http://openoffice.org/2009/office"',
	'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"'
].join(" ")

export interface OdpFixture {
	// office:automatic-styles of content.xml.
	readonly automatic?: string
	// office:presentation's content (draw:page elements, declarations, settings).
	readonly body: string
	// office:styles, office:automatic-styles and office:master-styles of styles.xml.
	readonly styles?: string
	readonly stylesAutomatic?: string
	readonly masters?: string
	readonly mediaType?: string
	readonly extra?: readonly { readonly name: string; readonly data: Uint8Array; readonly mediaType?: string }[]
	readonly manifestEntries?: string
}

// A master page "M" of 28 × 21 cm with a title and an outline shape, and one of each footer.
export const DEFAULT_MASTER =
	'<style:master-page style:name="M" style:page-layout-name="PM1" draw:style-name="Mdp">' +
	'<draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box/></draw:frame>' +
	'<draw:frame presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="13cm"><draw:text-box/></draw:frame>' +
	'<draw:frame presentation:class="footer" svg:x="9cm" svg:y="19cm" svg:width="10cm" svg:height="1.5cm"><draw:text-box><text:p><presentation:footer/></text:p></draw:text-box></draw:frame>' +
	'<draw:frame presentation:class="page-number" svg:x="20cm" svg:y="19cm" svg:width="6cm" svg:height="1.5cm"><draw:text-box><text:p><text:page-number>&lt;number&gt;</text:page-number></text:p></draw:text-box></draw:frame>' +
	"</style:master-page>"

export const DEFAULT_STYLES_AUTOMATIC =
	'<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm"/></style:page-layout>' +
	'<style:style style:name="Mdp" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#ffeedd"/></style:style>'

export function odpBytes(fixture: OdpFixture): Uint8Array {
	const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODP_NS} office:version="1.3"><office:automatic-styles>${fixture.automatic ?? ""}</office:automatic-styles><office:body><office:presentation>${fixture.body}</office:presentation></office:body></office:document-content>`
	const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODP_NS} office:version="1.3"><office:styles>${fixture.styles ?? ""}</office:styles><office:automatic-styles>${fixture.stylesAutomatic ?? DEFAULT_STYLES_AUTOMATIC}</office:automatic-styles><office:master-styles>${fixture.masters ?? DEFAULT_MASTER}</office:master-styles></office:document-styles>`
	const mediaType = fixture.mediaType ?? "application/vnd.oasis.opendocument.presentation"
	const extra = fixture.extra ?? []
	const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mediaType}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>${extra.map(entry => `<manifest:file-entry manifest:full-path="${entry.name}" manifest:media-type="${entry.mediaType ?? ""}"/>`).join("")}${fixture.manifestEntries ?? ""}</manifest:manifest>`

	return buildZip([
		{ name: "mimetype", data: text(mediaType), method: 0 },
		{ name: "content.xml", data: text(content) },
		{ name: "styles.xml", data: text(styles) },
		...extra.map(entry => ({ name: entry.name, data: entry.data })),
		{ name: "META-INF/manifest.xml", data: text(manifest) }
	])
}

export async function openOdpFixture(
	fixture: OdpFixture,
	options: OdpOpenOptions = {}
): Promise<{ readonly deck: Deck; readonly parts: OdpParts }> {
	const opened = await openOdp(bytesSource(odpBytes(fixture)), options)

	if (opened.kind !== "opened") throw new Error(`${opened.reason}: ${opened.detail ?? ""}`)

	return opened
}

export async function slideOf(opened: { readonly deck: Deck; readonly parts: OdpParts }, index: number): Promise<SlideNode> {
	const ref = opened.deck.slides[index]

	if (ref === undefined) throw new Error(`no slide ${String(index)}`)

	return opened.parts.slide(ref)
}

export function plainText(shape: ShapeNode | undefined): string {
	return (shape?.text?.paragraphs ?? [])
		.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
		.join("\n")
}

export function page(content: string, attributes = 'draw:master-page-name="M"'): string {
	return `<draw:page draw:name="page" ${attributes}>${content}</draw:page>`
}
