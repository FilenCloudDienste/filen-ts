// Namespaces of ODF 1.3 Part 3 §1.5 and Part 2 §4 (manifest), plus the foreign namespaces LibreOffice and
// OpenOffice write into ODF files. Names are compared as (URI, local name) only: every reader canonicalizes a
// qualified name to the prefix below, so a file binding "o:" to the office namespace reads like any other.
export const OdfNs = {
	office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
	style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
	text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
	table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
	draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
	fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
	xlink: "http://www.w3.org/1999/xlink",
	dc: "http://purl.org/dc/elements/1.1/",
	meta: "urn:oasis:names:tc:opendocument:xmlns:meta:1.0",
	number: "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
	svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
	chart: "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
	dr3d: "urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0",
	math: "http://www.w3.org/1998/Math/MathML",
	form: "urn:oasis:names:tc:opendocument:xmlns:form:1.0",
	script: "urn:oasis:names:tc:opendocument:xmlns:script:1.0",
	presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
	anim: "urn:oasis:names:tc:opendocument:xmlns:animation:1.0",
	smil: "urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0",
	config: "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
	db: "urn:oasis:names:tc:opendocument:xmlns:database:1.0",
	xforms: "http://www.w3.org/2002/xforms",
	xhtml: "http://www.w3.org/1999/xhtml",
	grddl: "http://www.w3.org/2003/g/data-view#",
	of: "urn:oasis:names:tc:opendocument:xmlns:of:1.2",
	manifest: "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
	loext: "urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0",
	calcext: "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0",
	field: "urn:openoffice:names:experimental:ooo-ms-interop:xmlns:field:1.0",
	formx: "urn:openoffice:names:experimental:ooxml-odf-interop:xmlns:form:1.0",
	ooo: "http://openoffice.org/2004/office",
	ooow: "http://openoffice.org/2004/writer",
	oooc: "http://openoffice.org/2004/calc",
	officeooo: "http://openoffice.org/2009/office",
	tableooo: "http://openoffice.org/2009/table",
	drawooo: "http://openoffice.org/2010/draw",
	css3t: "http://www.w3.org/TR/css3-text/",
	rpt: "http://openoffice.org/2005/report"
} as const

export type OdfPrefix = keyof typeof OdfNs

const PREFIX_BY_URI: ReadonlyMap<string, string> = new Map(Object.entries(OdfNs).map(([prefix, uri]) => [uri, prefix]))

// The prefix this table gives a namespace URI; undefined for one it does not know.
export function odfPrefixOf(uri: string): string | undefined {
	return PREFIX_BY_URI.get(uri)
}

// The namespaces of the StarOffice/OpenOffice.org 1.x XML formats (.sxw, .sxc), which are not ODF.
export const LEGACY_OFFICE_NAMESPACE = "http://openoffice.org/2000/office"

// The canonical qualified name for (uri, local): "fo:font-size" whatever prefix the file used; a namespace this
// table does not know keeps its URI ("{uri}local"), an unqualified name stays bare.
export function canonicalName(uri: string | undefined, local: string): string {
	if (uri === undefined || uri === "") return local

	const prefix = PREFIX_BY_URI.get(uri)

	return prefix === undefined ? `{${uri}}${local}` : `${prefix}:${local}`
}
