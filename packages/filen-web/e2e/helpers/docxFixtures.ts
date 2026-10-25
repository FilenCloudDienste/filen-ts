import { crc32, deflateSync } from "node:zlib"
import { buildZip } from "./archiveFixtures"

// The DOCX editing specs' documents and pictures, built here byte for byte (no binary checked in): one small
// synthetic .docx per feature the editor's web UI works on (comments, tracked changes, tables, a right-to-left
// table, a table of contents, content controls, equations, headers and footers), each carrying a line of
// text a spec finds it by, and the pictures an insert leg feeds the image pipeline (one over the 25 MiB
// limit, a WebP that is converted, an SVG that gets a PNG fallback).
//
// Specs that SAVE a document upload these bytes into their own scratch directory instead: the shared tree is
// read-only.

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const NS = [
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
	'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
	'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
	'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
	'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
	'mc:Ignorable="w14"'
].join(" ")
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml"
const DATE = "2026-01-01T00:00:00Z"
const AUTHOR = 'w:author="E2E Reviewer" w:date="2026-01-01T00:00:00Z"'

// The line of text each document is found by, by file name.
export const DOCX_FIXTURE_TEXT = {
	"w3-comments.docx": "W3 comments fixture",
	"w3-tracked.docx": "W3 tracked fixture",
	"w3-tables.docx": "W3 tables fixture",
	"w3-rtl-table.docx": "W3 right-to-left table fixture",
	"w3-toc.docx": "W3 contents fixture",
	"w3-forms.docx": "W3 forms fixture",
	"w3-equations.docx": "W3 equations fixture",
	"w3-headers.docx": "W3 headers fixture",
	"notes.docx": "Notes document fixture",
	"described-picture.docx": "Described picture fixture"
} as const

export type DocxFixtureName = keyof typeof DOCX_FIXTURE_TEXT

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function run(text: string): string {
	return `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`
}

function paragraph(content: string, style?: string): string {
	return `<w:p>${style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${content}</w:p>`
}

const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

interface DocxParts {
	body: string
	// Section properties ending the body (Letter, 1" margins by default).
	section?: string
	// Further parts of word/: file name, content type (after the wordprocessingml prefix), relationship type
	// (after the relationships namespace) and XML; each gets rId<n> in order, from rId1.
	parts?: readonly { name: string; type: string; relationship: string; xml: string }[]
	// More relationships of the main part (links, pictures), by their own ids.
	links?: readonly { id: string; type: string; target: string; external?: boolean }[]
	// Raw package entries (binary parts, other parts' relationships) and the default content types they need.
	entries?: readonly { name: string; data: Buffer | string }[]
	defaults?: readonly { extension: string; type: string }[]
	// Leaves [Content_Types].xml out: not a valid package (OPC requires it), though the parts all read.
	withoutContentTypes?: boolean
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

function docx({
	body,
	section = SECTION,
	parts = [],
	links = [],
	entries = [],
	defaults = [],
	withoutContentTypes = false
}: DocxParts): Buffer {
	const overrides = parts.map(part => `<Override PartName="/word/${part.name}" ContentType="${CT}.${part.type}+xml"/>`).join("")
	const extensions = defaults.map(entry => `<Default Extension="${entry.extension}" ContentType="${entry.type}"/>`).join("")
	const relationships =
		parts
			.map((part, index) => `<Relationship Id="rId${String(index + 1)}" Type="${REL}/${part.relationship}" Target="${part.name}"/>`)
			.join("") +
		links
			.map(
				link =>
					`<Relationship Id="${link.id}" Type="${REL}/${link.type}" Target="${escape(link.target).replace(/"/g, "&quot;")}"${link.external === true ? ' TargetMode="External"' : ""}/>`
			)
			.join("")

	return buildZip([
		...(withoutContentTypes
			? []
			: [
					{
						name: "[Content_Types].xml",
						data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extensions}<Override PartName="/word/document.xml" ContentType="${CT}.document.main+xml"/>${overrides}</Types>`
					}
				]),
		{
			name: "_rels/.rels",
			data: `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`
		},
		{ name: "word/document.xml", data: `${XML}<w:document ${NS}><w:body>${body}${section}</w:body></w:document>` },
		{
			name: "word/_rels/document.xml.rels",
			data: `${XML}<Relationships xmlns="${RELS_NS}">${relationships}</Relationships>`
		},
		...parts.map(part => ({ name: `word/${part.name}`, data: `${XML}${part.xml}` })),
		...entries
	])
}

const BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="000000"'

function table(rtl: boolean): string {
	const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraph(run(text))}</w:tc>`
	const row = (cells: readonly string[]): string => `<w:tr>${cells.map(cell).join("")}</w:tr>`

	return (
		`<w:tbl><w:tblPr>${rtl ? "<w:bidiVisual/>" : ""}<w:tblW w:w="0" w:type="auto"/><w:tblBorders>` +
		`<w:top ${BORDER}/><w:left ${BORDER}/><w:bottom ${BORDER}/><w:right ${BORDER}/><w:insideH ${BORDER}/><w:insideV ${BORDER}/>` +
		`</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
		row(["A1", "B1", "C1"]) +
		row(["A2", "B2", "C2"]) +
		"</w:tbl>"
	)
}

function control(properties: string, text: string): string {
	return `<w:sdt><w:sdtPr>${properties}</w:sdtPr><w:sdtContent>${run(text)}</w:sdtContent></w:sdt>`
}

const BUILDERS: Readonly<Record<DocxFixtureName, () => Buffer>> = {
	"w3-comments.docx": () =>
		docx({
			body:
				paragraph(
					`<w:commentRangeStart w:id="0"/>${run(DOCX_FIXTURE_TEXT["w3-comments.docx"])}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`
				) + paragraph(run("A second paragraph without comments.")),
			parts: [
				{
					name: "comments.xml",
					type: "comments",
					relationship: "comments",
					xml: `<w:comments ${NS}><w:comment w:id="0" ${AUTHOR} w:initials="ER">${paragraph(run("A fixture comment."))}</w:comment></w:comments>`
				}
			]
		}),
	"w3-tracked.docx": () =>
		docx({
			body:
				paragraph(
					`${run(`${DOCX_FIXTURE_TEXT["w3-tracked.docx"]} `)}<w:ins w:id="1" ${AUTHOR}>${run("inserted ")}</w:ins><w:del w:id="2" ${AUTHOR}><w:r><w:delText>deleted</w:delText></w:r></w:del>`
				) + paragraph(run("An untracked paragraph."))
		}),
	"w3-tables.docx": () =>
		docx({ body: paragraph(run(DOCX_FIXTURE_TEXT["w3-tables.docx"])) + table(false) + paragraph(run("After the table.")) }),
	"w3-rtl-table.docx": () =>
		docx({ body: paragraph(run(DOCX_FIXTURE_TEXT["w3-rtl-table.docx"])) + table(true) + paragraph(run("After the table.")) }),
	"w3-toc.docx": () =>
		docx({
			body:
				paragraph(run(DOCX_FIXTURE_TEXT["w3-toc.docx"])) +
				paragraph(
					'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
						`<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("No table of contents entries found.")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
				) +
				paragraph(run("Chapter one"), "Heading1") +
				paragraph(run("Body text of chapter one.")) +
				paragraph(run("Section one point one"), "Heading2") +
				paragraph(run("Chapter two"), "Heading1"),
			parts: [
				{
					name: "styles.xml",
					type: "styles",
					relationship: "styles",
					xml:
						`<w:styles ${NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
						[1, 2]
							.map(
								level =>
									`<w:style w:type="paragraph" w:styleId="Heading${String(level)}"><w:name w:val="heading ${String(level)}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="${String(level - 1)}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`
							)
							.join("") +
						"</w:styles>"
				}
			]
		}),
	"w3-forms.docx": () =>
		docx({
			body:
				paragraph(run(DOCX_FIXTURE_TEXT["w3-forms.docx"])) +
				paragraph(
					run("Agree: ") +
						control(
							'<w:id w:val="101"/><w14:checkbox><w14:checked w14:val="0"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>',
							"☐"
						)
				) +
				paragraph(
					run("Colour: ") +
						control(
							'<w:id w:val="102"/><w:dropDownList w:lastValue="Red"><w:listItem w:displayText="Red" w:value="Red"/><w:listItem w:displayText="Green" w:value="Green"/></w:dropDownList>',
							"Red"
						)
				) +
				paragraph(
					run("Date: ") +
						control(
							`<w:id w:val="103"/><w:date w:fullDate="${DATE}"><w:dateFormat w:val="M/d/yyyy"/><w:lid w:val="en-US"/><w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date>`,
							"1/1/2026"
						)
				) +
				paragraph(run("Name: ") + control('<w:id w:val="104"/><w:text/>', "Plain text control"))
		}),
	"w3-equations.docx": () =>
		docx({
			body:
				paragraph(
					run(`${DOCX_FIXTURE_TEXT["w3-equations.docx"]}: `) +
						"<m:oMath><m:sSup><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>+</m:t></m:r>" +
						"<m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>"
				) +
				paragraph(
					"<m:oMathPara><m:oMath><m:r><m:t>x=</m:t></m:r><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>"
				)
		}),
	"w3-headers.docx": () =>
		docx({
			body: paragraph(run(DOCX_FIXTURE_TEXT["w3-headers.docx"])),
			section:
				'<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/>' +
				SECTION.slice("<w:sectPr>".length),
			parts: [
				{
					name: "header1.xml",
					type: "header",
					relationship: "header",
					xml: `<w:hdr ${NS}>${paragraph(run("W3 header text"))}</w:hdr>`
				},
				{
					name: "footer1.xml",
					type: "footer",
					relationship: "footer",
					xml: `<w:ftr ${NS}>${paragraph(run("W3 footer text"))}</w:ftr>`
				}
			]
		}),
	"notes.docx": () =>
		docx({
			body:
				paragraph(
					run(`${DOCX_FIXTURE_TEXT["notes.docx"]} with a footnote`) +
						'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>' +
						run(" and an endnote") +
						'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="1"/></w:r>'
				) + paragraph(run("After the notes.")),
			parts: [
				{ name: "footnotes.xml", type: "footnotes", relationship: "footnotes", xml: notes("footnote", "Footnote fixture text") },
				{ name: "endnotes.xml", type: "endnotes", relationship: "endnotes", xml: notes("endnote", "Endnote fixture text") }
			]
		}),
	"described-picture.docx": () =>
		docx({
			body:
				paragraph(run(DOCX_FIXTURE_TEXT["described-picture.docx"])) +
				paragraph(`<w:r>${inlinePicture("rIdPicture1", 1905000, 1270000)}</w:r>`),
			links: [{ id: "rIdPicture1", type: "image", target: "media/image1.png" }],
			entries: [{ name: "word/media/image1.png", data: solidPng(12, 8) }],
			defaults: [{ extension: "png", type: "image/png" }]
		})
}

// A notes part: the two separators Word writes, then note 1.
function notes(kind: "footnote" | "endnote", text: string): string {
	return (
		`<w:${kind}s ${NS}>` +
		`<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>` +
		`<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>` +
		`<w:${kind} w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Ref/></w:r>${run(` ${text}`)}</w:p></w:${kind}>` +
		`</w:${kind}s>`
	)
}

// The alternative text of described-picture.docx's and viewer-review.docx's pictures: their accessible name.
export const DOCX_PICTURE_ALT = "A blue rectangle"

// An inline picture (EMU size) of the image behind relationship `id`.
function inlinePicture(id: string, cx: number, cy: number): string {
	const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
	const extent = `cx="${String(cx)}" cy="${String(cy)}"`

	return (
		'<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
		`<wp:extent ${extent}/><wp:docPr id="1" name="Picture 1" descr="${DOCX_PICTURE_ALT}"/>` +
		`<wp:cNvGraphicFramePr><a:graphicFrameLocks ${a} noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
		`<a:graphic ${a}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
		'<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
		`<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext ${extent}/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
		"</a:graphicData></a:graphic></wp:inline></w:drawing>"
	)
}

export function docxFixtureBytes(name: DocxFixtureName): Buffer {
	return BUILDERS[name]()
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	const typed = Buffer.concat([Buffer.from(type, "ascii"), data])
	const crc = Buffer.alloc(4)

	length.writeUInt32BE(data.length)
	crc.writeUInt32BE(crc32(typed))

	return Buffer.concat([length, typed, crc])
}

// A valid 3000 x 3000 RGB PNG of about 27 MB (stored, not compressed): over the 25 MiB a picture may have,
// under its 20 MP, so only its size refuses it.
export function largePictureBytes(): Buffer {
	const side = 3000
	const header = Buffer.alloc(13)

	header.writeUInt32BE(side, 0)
	header.writeUInt32BE(side, 4)
	header[8] = 8
	header[9] = 2

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.alloc((side * 3 + 1) * side), { level: 0 })),
		pngChunk("IEND", Buffer.alloc(0))
	])
}

// A solid blue RGB PNG.
function solidPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13)
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [0x3b, 0x82, 0xf6]).flat())])

	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8
	header[9] = 2

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		pngChunk("IEND", Buffer.alloc(0))
	])
}

// A 1 x 1 lossless WebP (VP8L).
export function webpPictureBytes(): Buffer {
	return Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64")
}

// A 120 x 80 SVG.
export function svgPictureBytes(): Buffer {
	return Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#3b82f6"/></svg>',
		"utf8"
	)
}

// ── The viewer's subjects (scenario "docx-viewer") ───────────────────────────────────────────────────────

// The line of text each readable viewer document is found by. The archives hold VIEWER_ENTRY_NAME, and the zip also
// VIEWER_ARCHIVE_DOCUMENTS (a document in the drive opens in the editor, an archive's entry in the viewer); the
// encrypted and legacy files hold no text a viewer can show.
export const DOCX_VIEWER_TEXT = {
	"viewer-300p.docx": "Viewer 300 pages fixture",
	"viewer-fonts.docx": "Viewer embedded font fixture",
	"viewer-links.docx": "Viewer links fixture",
	"viewer-malformed.docx": "Viewer malformed package fixture",
	"viewer-review.docx": "Viewer review fixture"
} as const

export type DocxViewerFile =
	keyof typeof DOCX_VIEWER_TEXT | "viewer-archive.7z" | "viewer-archive.zip" | "viewer-encrypted.docx" | "viewer-legacy.docx"

export const VIEWER_ENTRY_NAME = "viewer-entry.docx"
// The viewer documents the zip holds beside VIEWER_ENTRY_NAME.
export const VIEWER_ARCHIVE_DOCUMENTS = ["viewer-300p.docx", "viewer-fonts.docx", "viewer-links.docx", "viewer-review.docx"] as const
export const VIEWER_ENTRY_TEXT = "Viewer archive entry fixture"
export const VIEWER_PAGES = 300
// The embedded font's family, and the text set in it (every glyph a 1 em box) beside the same text in the default font.
export const VIEWER_FONT_FAMILY = "E2E Box Sans"
export const VIEWER_FONT_SAMPLE = "iiiiiiiiii"
export const VIEWER_FONT_PLAIN = "Plain iiiiiiiiii"
// The links document's links, by their text.
export const VIEWER_LINKS = {
	web: { text: "Safe web link", href: "https://example.com/e2e-viewer" },
	mail: { text: "Mail link", href: "mailto:e2e@example.com" },
	script: { text: "Script link", href: "javascript:alert(document.domain)" },
	data: { text: "Data link", href: "data:text/html,<script>alert(1)</script>" },
	internal: { text: "Internal link", anchor: "e2e_target" }
} as const
export const VIEWER_LINK_TARGET_TEXT = "Viewer link target on page three"

const PAGE_BREAK = '<w:r><w:br w:type="page"/></w:r>'

function hyperlink(attributes: string, text: string): string {
	return `<w:hyperlink ${attributes}><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:hyperlink>`
}

// GUID of the embedded font's obfuscation key (ECMA-376 Part 1 §17.8.1).
const FONT_KEY = "{6C1A3F52-9B0D-4E7A-8C21-5D4F0E3B7A96}"

function obfuscated(font: Buffer, guid: string): Buffer {
	const hex = guid.replace(/[{}-]/g, "")
	const key = Buffer.alloc(16)
	const out = Buffer.from(font)

	for (let i = 0; i < 16; i++) {
		key[15 - i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}

	for (let i = 0; i < 32; i++) {
		out[i] = (out[i] ?? 0) ^ (key[i % 16] ?? 0)
	}

	return out
}

const VIEWER_BUILDERS: Readonly<Record<DocxViewerFile, () => Buffer>> = {
	"viewer-300p.docx": () =>
		docx({
			body: Array.from(
				{ length: VIEWER_PAGES },
				(_, index) =>
					paragraph(run(index === 0 ? DOCX_VIEWER_TEXT["viewer-300p.docx"] : `Viewer page ${String(index + 1)}`)) +
					(index + 1 < VIEWER_PAGES ? paragraph(PAGE_BREAK) : "")
			).join("")
		}),
	"viewer-encrypted.docx": () =>
		compoundFile([
			{ name: "EncryptionInfo", data: Buffer.alloc(4096, 0x04) },
			{ name: "EncryptedPackage", data: Buffer.alloc(8192, 0xa5) }
		]),
	"viewer-fonts.docx": () =>
		docx({
			body:
				paragraph(run(DOCX_VIEWER_TEXT["viewer-fonts.docx"])) +
				paragraph(
					`<w:r><w:rPr><w:rFonts w:ascii="${VIEWER_FONT_FAMILY}" w:hAnsi="${VIEWER_FONT_FAMILY}"/><w:sz w:val="32"/></w:rPr><w:t>${VIEWER_FONT_SAMPLE}</w:t></w:r>`
				) +
				paragraph(`<w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${VIEWER_FONT_PLAIN}</w:t></w:r>`),
			parts: [
				{
					name: "fontTable.xml",
					type: "fontTable",
					relationship: "fontTable",
					xml: `<w:fonts ${NS}><w:font w:name="${VIEWER_FONT_FAMILY}"><w:family w:val="swiss"/><w:pitch w:val="fixed"/><w:embedRegular r:id="rId1" w:fontKey="${FONT_KEY}"/></w:font></w:fonts>`
				},
				{
					name: "settings.xml",
					type: "settings",
					relationship: "settings",
					xml: `<w:settings ${NS}><w:embedTrueTypeFonts/></w:settings>`
				}
			],
			entries: [
				{
					name: "word/_rels/fontTable.xml.rels",
					data: `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/font" Target="fonts/font1.odttf"/></Relationships>`
				},
				{ name: "word/fonts/font1.odttf", data: obfuscated(boxFont(VIEWER_FONT_FAMILY), FONT_KEY) }
			],
			defaults: [{ extension: "odttf", type: "application/vnd.openxmlformats-officedocument.obfuscatedFont" }]
		}),
	// A Word 95 header (FibBase wIdent 0xA5EC, nFib 0x68): readable as Word, a version before Word 97's format.
	"viewer-legacy.docx": () => {
		const word = Buffer.alloc(4096)

		word.writeUInt16LE(0xa5ec, 0)
		word.writeUInt16LE(0x68, 2)

		return compoundFile([{ name: "WordDocument", data: word }])
	},
	"viewer-archive.zip": () =>
		buildZip([
			{ name: VIEWER_ENTRY_NAME, data: viewerEntry() },
			...VIEWER_ARCHIVE_DOCUMENTS.map(name => ({ name, data: VIEWER_BUILDERS[name]() }))
		]),
	"viewer-archive.7z": () => sevenZipStored(VIEWER_ENTRY_NAME, viewerEntry()),
	"viewer-links.docx": () =>
		docx({
			body:
				paragraph(run(DOCX_VIEWER_TEXT["viewer-links.docx"])) +
				paragraph(hyperlink('r:id="rIdWeb"', VIEWER_LINKS.web.text)) +
				paragraph(hyperlink('r:id="rIdMail"', VIEWER_LINKS.mail.text)) +
				paragraph(hyperlink('r:id="rIdScript"', VIEWER_LINKS.script.text)) +
				paragraph(hyperlink('r:id="rIdData"', VIEWER_LINKS.data.text)) +
				paragraph(hyperlink(`w:anchor="${VIEWER_LINKS.internal.anchor}"`, VIEWER_LINKS.internal.text)) +
				paragraph(PAGE_BREAK) +
				paragraph(run("Viewer link page two")) +
				paragraph(PAGE_BREAK) +
				paragraph(
					`<w:bookmarkStart w:id="0" w:name="${VIEWER_LINKS.internal.anchor}"/>${run(VIEWER_LINK_TARGET_TEXT)}<w:bookmarkEnd w:id="0"/>`
				),
			links: [
				{ id: "rIdWeb", type: "hyperlink", target: VIEWER_LINKS.web.href, external: true },
				{ id: "rIdMail", type: "hyperlink", target: VIEWER_LINKS.mail.href, external: true },
				{ id: "rIdScript", type: "hyperlink", target: VIEWER_LINKS.script.href, external: true },
				{ id: "rIdData", type: "hyperlink", target: VIEWER_LINKS.data.href, external: true }
			]
		}),
	// OPC requires [Content_Types].xml (ECMA-376 Part 2 §10.1.2.2): the engine refuses the package, docx-preview
	// reads it anyway, so this is the one document shown by the fallback.
	"viewer-malformed.docx": () => docx({ body: paragraph(run(DOCX_VIEWER_TEXT["viewer-malformed.docx"])), withoutContentTypes: true }),
	"viewer-review.docx": () =>
		docx({
			body:
				paragraph(
					`<w:commentRangeStart w:id="0"/>${run(DOCX_VIEWER_TEXT["viewer-review.docx"])}<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`
				) +
				paragraph(
					`${run("Tracked: ")}<w:ins w:id="1" ${AUTHOR}>${run("inserted words ")}</w:ins><w:del w:id="2" ${AUTHOR}><w:r><w:delText>deleted words</w:delText></w:r></w:del>`
				) +
				paragraph(`<w:r>${inlinePicture("rIdPicture1", 952500, 635000)}</w:r>`),
			links: [{ id: "rIdPicture1", type: "image", target: "media/image1.png" }],
			entries: [{ name: "word/media/image1.png", data: solidPng(12, 8) }],
			defaults: [{ extension: "png", type: "image/png" }],
			parts: [
				{
					name: "comments.xml",
					type: "comments",
					relationship: "comments",
					xml: `<w:comments ${NS}><w:comment w:id="0" ${AUTHOR} w:initials="ER">${paragraph(run("A viewer fixture comment."))}</w:comment></w:comments>`
				}
			]
		})
}

export function docxViewerBytes(name: DocxViewerFile): Buffer {
	return VIEWER_BUILDERS[name]()
}

function viewerEntry(): Buffer {
	return docx({ body: paragraph(run(VIEWER_ENTRY_TEXT)) })
}

// ── An OLE2 compound file (MS-CFB, version 3: 512-byte sectors) ──────────────────────────────────────────────
// Sector 0 holds the FAT, sector 1 the directory, the streams follow (each at least 4096 bytes, so in regular
// sectors rather than the mini stream). Directory entries: the root, then the streams as one right-leaning
// chain of siblings in the order CFB compares names (shorter first).

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const FATSECT = 0xfffffffd
const NOSTREAM = 0xffffffff

function compoundFile(streams: readonly { name: string; data: Buffer }[]): Buffer {
	const sorted = [...streams].sort((a, b) => a.name.length - b.name.length || a.name.toUpperCase().localeCompare(b.name.toUpperCase()))
	const header = Buffer.alloc(512)
	const fat = Buffer.alloc(512, 0xff)
	const directory = Buffer.alloc(512)
	const data: Buffer[] = []
	let sector = 2

	fat.writeUInt32LE(FATSECT, 0)
	fat.writeUInt32LE(ENDOFCHAIN, 4)

	const entry = (index: number, name: string, type: number, child: number, right: number, start: number, size: number): void => {
		const at = index * 128
		const encoded = Buffer.from(`${name}\0`, "utf16le")

		encoded.copy(directory, at)
		directory.writeUInt16LE(encoded.length, at + 0x40)
		directory[at + 0x42] = type
		directory[at + 0x43] = 1
		directory.writeUInt32LE(NOSTREAM, at + 0x44)
		directory.writeUInt32LE(right, at + 0x48)
		directory.writeUInt32LE(child, at + 0x4c)
		directory.writeUInt32LE(start, at + 0x74)
		directory.writeUInt32LE(size, at + 0x78)
	}

	entry(0, "Root Entry", 5, 1, NOSTREAM, ENDOFCHAIN, 0)

	for (const [index, stream] of sorted.entries()) {
		const sectors = Math.ceil(stream.data.length / 512)

		for (let k = 0; k < sectors; k++) {
			fat.writeUInt32LE(k + 1 < sectors ? sector + k + 1 : ENDOFCHAIN, (sector + k) * 4)
		}

		entry(index + 1, stream.name, 2, NOSTREAM, index + 1 < sorted.length ? index + 2 : NOSTREAM, sector, stream.data.length)
		data.push(stream.data, Buffer.alloc(sectors * 512 - stream.data.length))
		sector += sectors
	}

	for (let index = sorted.length + 1; index < 4; index++) {
		const at = index * 128

		directory.writeUInt32LE(NOSTREAM, at + 0x44)
		directory.writeUInt32LE(NOSTREAM, at + 0x48)
		directory.writeUInt32LE(NOSTREAM, at + 0x4c)
	}

	Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
	header.writeUInt16LE(0x003e, 0x18)
	header.writeUInt16LE(0x0003, 0x1a)
	header.writeUInt16LE(0xfffe, 0x1c)
	header.writeUInt16LE(9, 0x1e)
	header.writeUInt16LE(6, 0x20)
	header.writeUInt32LE(1, 0x2c)
	header.writeUInt32LE(1, 0x30)
	header.writeUInt32LE(0x1000, 0x38)
	header.writeUInt32LE(ENDOFCHAIN, 0x3c)
	header.writeUInt32LE(ENDOFCHAIN, 0x44)
	header.fill(0xff, 0x4c)
	header.writeUInt32LE(0, 0x4c)

	if (fat.readUInt32LE(sector * 4 - 4) === FREESECT) {
		throw new Error("compound file: the FAT does not cover the streams")
	}

	return Buffer.concat([header, fat, directory, ...data])
}

// ── A 7-Zip archive of one file, stored (Copy coder, 7zFormat.txt) ───────────────────────────────────────────

// 7z's variable-length NUMBER: a first byte whose leading one bits count the little-endian bytes after it.
function sevenZipNumber(value: number): Buffer {
	for (let extra = 0; extra < 8; extra++) {
		if (value < 2 ** (7 * (extra + 1))) {
			const out = Buffer.alloc(extra + 1)
			const high = Math.floor(value / 2 ** (8 * extra))

			out[0] = ((0xff << (8 - extra)) & 0xff) | high

			for (let k = 0; k < extra; k++) {
				out[k + 1] = Math.floor(value / 2 ** (8 * k)) & 0xff
			}

			return out
		}
	}

	throw new Error("7z number out of range")
}

function sevenZipStored(name: string, data: Buffer): Buffer {
	const n = sevenZipNumber
	const names = Buffer.concat([Buffer.from([0]), Buffer.from(`${name}\0`, "utf16le")])
	const digest = Buffer.alloc(4)

	digest.writeUInt32LE(crc32(data))

	const header = Buffer.concat([
		Buffer.from([0x01, 0x04]),
		// PackInfo: one stream at 0.
		Buffer.from([0x06]),
		n(0),
		n(1),
		Buffer.from([0x09]),
		n(data.length),
		Buffer.from([0x00]),
		// UnpackInfo: one folder of one Copy coder.
		Buffer.from([0x07, 0x0b]),
		n(1),
		Buffer.from([0x00, 0x01, 0x01, 0x00, 0x0c]),
		n(data.length),
		Buffer.from([0x00]),
		// SubStreamsInfo: the file's CRC.
		Buffer.from([0x08, 0x0a, 0x01]),
		digest,
		Buffer.from([0x00, 0x00]),
		// FilesInfo: one name.
		Buffer.from([0x05]),
		n(1),
		Buffer.from([0x11]),
		n(names.length),
		names,
		Buffer.from([0x00, 0x00])
	])
	const start = Buffer.alloc(20)

	start.writeBigUInt64LE(BigInt(data.length), 0)
	start.writeBigUInt64LE(BigInt(header.length), 8)
	start.writeUInt32LE(crc32(header), 16)

	const signature = Buffer.alloc(12)

	Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]).copy(signature)
	signature.writeUInt32LE(crc32(start), 8)

	return Buffer.concat([signature, start, data, header])
}

// ── A TrueType font whose every printable ASCII glyph is a filled 1 em box (OpenType 1.9 required tables) ───

function sfntChecksum(table: Buffer): number {
	const padded = Buffer.concat([table, Buffer.alloc((4 - (table.length % 4)) % 4)])
	let sum = 0

	for (let at = 0; at < padded.length; at += 4) {
		sum = (sum + padded.readUInt32BE(at)) >>> 0
	}

	return sum
}

function nameTable(family: string): Buffer {
	const postScript = `${family.replace(/[^A-Za-z0-9]/g, "")}-Regular`
	const records: [number, string][] = [
		[1, family],
		[2, "Regular"],
		[4, `${family} Regular`],
		[6, postScript]
	]
	const strings = records.map(([, text]) => Buffer.from(text, "utf16le").swap16())
	const head = Buffer.alloc(6 + records.length * 12)
	let offset = 0

	head.writeUInt16BE(0, 0)
	head.writeUInt16BE(records.length, 2)
	head.writeUInt16BE(head.length, 4)

	for (const [index, [id]] of records.entries()) {
		const at = 6 + index * 12
		const length = strings[index]?.length ?? 0

		head.writeUInt16BE(3, at)
		head.writeUInt16BE(1, at + 2)
		head.writeUInt16BE(0x0409, at + 4)
		head.writeUInt16BE(id, at + 6)
		head.writeUInt16BE(length, at + 8)
		head.writeUInt16BE(offset, at + 10)
		offset += length
	}

	return Buffer.concat([head, ...strings])
}

function boxFont(family: string): Buffer {
	const first = 0x20
	const last = 0x7e
	// .notdef, then one glyph per character first..last; the space is empty.
	const glyphCount = last - first + 2
	const box = Buffer.alloc(36)

	box.writeInt16BE(1, 0)
	box.writeInt16BE(50, 2)
	box.writeInt16BE(0, 4)
	box.writeInt16BE(950, 6)
	box.writeInt16BE(700, 8)
	box.writeUInt16BE(3, 10)
	box.writeUInt16BE(0, 12)
	box.fill(0x01, 14, 18)
	;[50, 900, 0, -900, 0, 0, 700, 0].forEach((delta, index) => box.writeInt16BE(delta, 18 + index * 2))

	const glyphs = Array.from({ length: glyphCount }, (_, glyph) => (glyph === 1 ? Buffer.alloc(0) : box))
	const loca = Buffer.alloc((glyphCount + 1) * 4)
	let at = 0

	for (const [glyph, data] of glyphs.entries()) {
		loca.writeUInt32BE(at, glyph * 4)
		at += data.length
	}

	loca.writeUInt32BE(at, glyphCount * 4)

	const hmtx = Buffer.alloc(glyphCount * 4)

	for (let glyph = 0; glyph < glyphCount; glyph++) {
		hmtx.writeUInt16BE(1000, glyph * 4)
		hmtx.writeInt16BE(glyph === 1 ? 0 : 50, glyph * 4 + 2)
	}

	const head = Buffer.alloc(54)

	head.writeUInt32BE(0x00010000, 0)
	head.writeUInt32BE(0x00010000, 4)
	head.writeUInt32BE(0x5f0f3cf5, 12)
	head.writeUInt16BE(0x000b, 16)
	head.writeUInt16BE(1000, 18)
	head.writeInt16BE(50, 36)
	head.writeInt16BE(0, 38)
	head.writeInt16BE(950, 40)
	head.writeInt16BE(700, 42)
	head.writeUInt16BE(8, 46)
	head.writeInt16BE(2, 48)
	head.writeInt16BE(1, 50)

	const hhea = Buffer.alloc(36)

	hhea.writeUInt32BE(0x00010000, 0)
	hhea.writeInt16BE(800, 4)
	hhea.writeInt16BE(-200, 6)
	hhea.writeUInt16BE(1000, 10)
	hhea.writeInt16BE(950, 16)
	hhea.writeInt16BE(1, 18)
	hhea.writeUInt16BE(glyphCount, 34)

	const maxp = Buffer.alloc(32)

	maxp.writeUInt32BE(0x00010000, 0)
	maxp.writeUInt16BE(glyphCount, 4)
	maxp.writeUInt16BE(4, 6)
	maxp.writeUInt16BE(1, 8)
	maxp.writeUInt16BE(2, 14)

	const os2 = Buffer.alloc(96)

	os2.writeUInt16BE(4, 0)
	os2.writeInt16BE(1000, 2)
	os2.writeUInt16BE(400, 4)
	os2.writeUInt16BE(5, 6)
	;[650, 600, 0, 75, 650, 600, 0, 350, 50, 300].forEach((value, index) => os2.writeInt16BE(value, 10 + index * 2))
	os2.writeUInt32BE(1, 42)
	os2.write("NONE", 58, "ascii")
	os2.writeUInt16BE(0x0040, 62)
	os2.writeUInt16BE(first, 64)
	os2.writeUInt16BE(last, 66)
	os2.writeInt16BE(800, 68)
	os2.writeInt16BE(-200, 70)
	os2.writeUInt16BE(800, 74)
	os2.writeUInt16BE(200, 76)
	os2.writeUInt32BE(1, 78)
	os2.writeInt16BE(500, 86)
	os2.writeInt16BE(700, 88)
	os2.writeUInt16BE(0x20, 92)

	// cmap: one Windows Unicode BMP subtable, format 4: first..last onto glyphs 1.., and the closing 0xFFFF segment.
	const cmap = Buffer.alloc(12 + 32)

	cmap.writeUInt16BE(1, 2)
	cmap.writeUInt16BE(3, 4)
	cmap.writeUInt16BE(1, 6)
	cmap.writeUInt32BE(12, 8)
	cmap.writeUInt16BE(4, 12)
	cmap.writeUInt16BE(32, 14)
	cmap.writeUInt16BE(4, 18)
	cmap.writeUInt16BE(4, 20)
	cmap.writeUInt16BE(1, 22)
	cmap.writeUInt16BE(last, 26)
	cmap.writeUInt16BE(0xffff, 28)
	cmap.writeUInt16BE(first, 32)
	cmap.writeUInt16BE(0xffff, 34)
	cmap.writeUInt16BE((1 - first) & 0xffff, 36)
	cmap.writeUInt16BE(1, 38)

	const post = Buffer.alloc(32)

	post.writeUInt32BE(0x00030000, 0)
	post.writeInt16BE(-100, 8)
	post.writeInt16BE(50, 10)
	post.writeUInt32BE(1, 12)

	const tables: [string, Buffer][] = [
		["OS/2", os2],
		["cmap", cmap],
		["glyf", Buffer.concat(glyphs)],
		["head", head],
		["hhea", hhea],
		["hmtx", hmtx],
		["loca", loca],
		["maxp", maxp],
		["name", nameTable(family)],
		["post", post]
	]
	const directory = Buffer.alloc(12 + tables.length * 16)
	const bodies: Buffer[] = []
	let offset = directory.length

	directory.writeUInt32BE(0x00010000, 0)
	directory.writeUInt16BE(tables.length, 4)
	directory.writeUInt16BE(128, 6)
	directory.writeUInt16BE(3, 8)
	directory.writeUInt16BE(tables.length * 16 - 128, 10)

	for (const [index, [tag, table]] of tables.entries()) {
		const at = 12 + index * 16

		directory.write(tag, at, "ascii")
		directory.writeUInt32BE(sfntChecksum(table), at + 4)
		directory.writeUInt32BE(offset, at + 8)
		directory.writeUInt32BE(table.length, at + 12)
		bodies.push(table, Buffer.alloc((4 - (table.length % 4)) % 4))
		offset += table.length + ((4 - (table.length % 4)) % 4)
	}

	const font = Buffer.concat([directory, ...bodies])
	const headAt = directory.readUInt32BE(12 + 3 * 16 + 8)

	font.writeUInt32BE((0xb1b0afba - sfntChecksum(font)) >>> 0, headAt + 8)

	return font
}
