import type { DocFont } from "../fonts"
import type { DocSectionProps } from "../props"
import { numberFormat } from "./numbering"
import { type PropsContext, border } from "./props"
import { STORY_NAMESPACES, attr, clamp, val } from "./xml"

// SttbfFfn → fontTable.xml (§17.8.3) and SEP → sectPr (§17.6).

const FAMILIES = ["auto", "roman", "swiss", "modern", "script", "decorative", "auto", "auto"]
const PITCHES = ["default", "fixed", "variable", "default"]

function hex(bytes: Uint8Array, from: number, count: number): string {
	let out = ""

	for (let k = from; k < from + count; k++) out += (bytes[k] ?? 0).toString(16).toUpperCase().padStart(2, "0")

	return out
}

function hexLe32(bytes: Uint8Array, at: number): string {
	const value = ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0

	return value.toString(16).toUpperCase().padStart(8, "0")
}

export function fontTablePart(fonts: readonly DocFont[]): string {
	const out: string[] = [`<w:fonts ${STORY_NAMESPACES}>`]
	const seen = new Set<string>()

	for (const font of fonts) {
		if (font.name === "" || seen.has(font.name)) continue

		seen.add(font.name)
		out.push(`<w:font${attr("w:name", font.name)}>`)
		if (font.altName !== undefined) out.push(val("altName", font.altName))
		if (font.panose.length === 10) out.push(val("panose1", hex(font.panose, 0, 10)))
		out.push(val("charset", font.charset.toString(16).toUpperCase().padStart(2, "0")))
		out.push(val("family", FAMILIES[font.family] ?? "auto"))
		if (!font.trueType) out.push("<w:notTrueType/>")
		out.push(val("pitch", PITCHES[font.pitch] ?? "default"))

		if (font.signature.length === 24) {
			out.push(
				`<w:sig${attr("w:usb0", hexLe32(font.signature, 0))}${attr("w:usb1", hexLe32(font.signature, 4))}${attr(
					"w:usb2",
					hexLe32(font.signature, 8)
				)}${attr("w:usb3", hexLe32(font.signature, 12))}${attr("w:csb0", hexLe32(font.signature, 16))}${attr(
					"w:csb1",
					hexLe32(font.signature, 20)
				)}/>`
			)
		}

		out.push("</w:font>")
	}

	out.push("</w:fonts>")

	return out.join("")
}

export interface HeaderReferences {
	readonly even?: { readonly header?: string; readonly footer?: string }
	readonly odd?: { readonly header?: string; readonly footer?: string }
	readonly first?: { readonly header?: string; readonly footer?: string }
}

const BREAKS = ["continuous", "nextColumn", "nextPage", "evenPage", "oddPage"]
const VALIGN = ["top", "center", "both", "bottom"]
const FLOWS: Readonly<Record<number, string>> = { 0: "lrTb", 1: "tbRl", 3: "btLr", 4: "lrTbV", 5: "tbRlV" }
const RESTARTS = ["continuous", "eachSect", "eachPage"]

// Footnote placement is per section (sprmSFpc); endnote placement has no sprm and lives in settings (DopBase epc).
function notePr(
	name: "footnotePr" | "endnotePr",
	footnotePosition: number | undefined,
	format: number | undefined,
	start: number | undefined,
	restart: number | undefined
): string {
	let inner = ""

	// sprmSFpc: 2 immediately after the text, else the bottom margin.
	if (footnotePosition !== undefined) inner += val("pos", footnotePosition === 2 ? "beneathText" : "pageBottom")

	if (format !== undefined) inner += val("numFmt", numberFormat(format))
	if (start !== undefined && start > 0) inner += val("numStart", start)
	if (restart !== undefined) inner += val("numRestart", RESTARTS[restart] ?? "continuous")

	return inner === "" ? "" : `<w:${name}>${inner}</w:${name}>`
}

export function sectionProperties(props: DocSectionProps, references: HeaderReferences, context: PropsContext): string {
	const out: string[] = ["<w:sectPr>"]

	for (const [kind, set] of [
		["even", references.even],
		["default", references.odd],
		["first", references.first]
	] as const) {
		if (set?.header !== undefined) out.push(`<w:headerReference${attr("w:type", kind)}${attr("r:id", set.header)}/>`)
	}

	for (const [kind, set] of [
		["even", references.even],
		["default", references.odd],
		["first", references.first]
	] as const) {
		if (set?.footer !== undefined) out.push(`<w:footerReference${attr("w:type", kind)}${attr("r:id", set.footer)}/>`)
	}

	out.push(notePr("footnotePr", props.footnotePosition, props.footnoteFormat, props.footnoteStart, props.footnoteRestart))
	out.push(notePr("endnotePr", undefined, props.endnoteFormat, props.endnoteStart, props.endnoteRestart))
	out.push(val("type", BREAKS[props.breakType] ?? "nextPage"))

	const width = clamp(props.pageWidth > 0 ? props.pageWidth : 12240, 1, 31680)
	const height = clamp(props.pageHeight > 0 ? props.pageHeight : 15840, 1, 31680)

	out.push(`<w:pgSz${attr("w:w", width)}${attr("w:h", height)}${props.landscape ? ' w:orient="landscape"' : ""}/>`)
	out.push(
		`<w:pgMar${attr("w:top", clamp(props.marginTop, -31680, 31680))}${attr("w:right", clamp(props.marginRight, 0, 31680))}${attr(
			"w:bottom",
			clamp(props.marginBottom, -31680, 31680)
		)}${attr("w:left", clamp(props.marginLeft, 0, 31680))}${attr("w:header", clamp(props.headerDistance, 0, 31680))}${attr(
			"w:footer",
			clamp(props.footerDistance, 0, 31680)
		)}${attr("w:gutter", clamp(props.gutter, 0, 31680))}/>`
	)

	const borders = [
		border("top", props.borderTop, context),
		border("left", props.borderLeft, context),
		border("bottom", props.borderBottom, context),
		border("right", props.borderRight, context)
	].join("")

	if (borders !== "") {
		// pgbApplyTo:3 pgbPageDepth:2 pgbOffsetFrom:3 (§2.9.? PGBOperand / sprmSPgbProp).
		const options = props.pageBorderOptions
		const applyTo = options & 7
		const display = applyTo === 1 ? "firstPage" : applyTo === 2 ? "notFirstPage" : "allPages"

		out.push(
			`<w:pgBorders${attr("w:zOrder", (options & 0x18) !== 0 ? "back" : "front")}${attr("w:display", display)}${attr(
				"w:offsetFrom",
				(options & 0xe0) !== 0 ? "page" : "text"
			)}>${borders}</w:pgBorders>`
		)
	}

	if (props.lineNumbering !== undefined && props.lineNumbering.countBy > 0) {
		const ln = props.lineNumbering

		out.push(
			`<w:lnNumType${attr("w:countBy", clamp(ln.countBy, 1, 100))}${attr("w:start", clamp(ln.start, 0, 32767))}${attr(
				"w:distance",
				clamp(ln.distance, 0, 31680)
			)}${attr("w:restart", ln.restart === 1 ? "newSection" : ln.restart === 2 ? "continuous" : "newPage")}/>`
		)
	}

	if (props.pageNumberFormat !== 0 || props.pageNumberRestart) {
		out.push(
			`<w:pgNumType${props.pageNumberFormat === 0 ? "" : attr("w:fmt", numberFormat(props.pageNumberFormat))}${
				props.pageNumberRestart ? attr("w:start", clamp(props.pageNumberStart, 0, 32767)) : ""
			}/>`
		)
	}

	let cols = `${attr("w:space", clamp(props.columnSpacing, 0, 31680))}`

	if (props.columns > 1) cols += attr("w:num", clamp(props.columns, 1, 45))
	if (props.lineBetween) cols += ' w:sep="1"'

	if (!props.evenlySpaced && props.columns > 1 && props.columnWidths.length >= props.columns) {
		out.push(
			`<w:cols${cols} w:equalWidth="0">${props.columnWidths
				.slice(0, props.columns)
				.map(column => `<w:col${attr("w:w", clamp(column.width, 1, 31680))}${attr("w:space", clamp(column.spacing, 0, 31680))}/>`)
				.join("")}</w:cols>`
		)
	} else {
		out.push(`<w:cols${cols}/>`)
	}

	if (props.formsProtected) out.push("<w:formProt/>")
	if (props.vertAlign !== 0) out.push(val("vAlign", VALIGN[props.vertAlign] ?? "top"))
	if (props.titlePage) out.push("<w:titlePg/>")
	if (props.textFlow !== 0 && FLOWS[props.textFlow] !== undefined) out.push(val("textDirection", FLOWS[props.textFlow] ?? "lrTb"))
	if (props.rtl) out.push("<w:bidi/>")

	const gridTypes = ["default", "lines", "linesAndChars", "snapToChars"]
	let grid = attr("w:type", gridTypes[props.gridType] ?? "default")

	if (props.linePitch > 0) grid += attr("w:linePitch", clamp(props.linePitch, 0, 31680))
	if (props.charSpace !== 0) grid += attr("w:charSpace", props.charSpace)

	out.push(`<w:docGrid${grid}/>`)
	out.push("</w:sectPr>")

	return out.join("")
}
