import { readColorIn, type DrawingTheme } from "./color"
import {
	isTextAlign,
	isTextAnchor,
	isTextUnderline,
	isTextVertical,
	rgba,
	type Inset,
	type Rgba,
	type TextAlign,
	type TextBodyProps,
	type TextParagraph,
	type TextRun,
	type TextUnderline
} from "./displayList"
import { D, EMU_PER_PX, type DrawingReader } from "./reader"

// DrawingML text (a:txBody, §21.1.2) as input descriptions for text layout. Nothing is measured here.

// The run properties text falls back to (a style's font reference, a chart's text properties).
export interface TextDefaults {
	readonly size: number
	readonly color: Rgba
	readonly font: string
	readonly bold: boolean
	readonly italic: boolean
}

export const DEFAULT_TEXT: TextDefaults = { size: 18, color: rgba("000000"), font: "", bold: false, italic: false }

// a:bodyPr insets default to 0.1in left/right and 0.05in top/bottom.
const DEFAULT_INSETS: Inset = { left: 96 / 10, top: 96 / 20, right: 96 / 10, bottom: 96 / 20 }

export function readBodyProps(reader: DrawingReader, bodyPr: number, defaults: Partial<TextBodyProps> = {}): TextBodyProps {
	const insets = defaults.insets ?? DEFAULT_INSETS
	const anchor = reader.attr(bodyPr, "anchor")
	const vertical = reader.attr(bodyPr, "vert")
	const normal = reader.child(bodyPr, D.A, "normAutofit")
	const autofit =
		reader.child(bodyPr, D.A, "spAutoFit") >= 0
			? "shape"
			: normal >= 0
				? "normal"
				: reader.child(bodyPr, D.A, "noAutofit") >= 0
					? "none"
					: (defaults.autofit ?? "none")

	return {
		insets: {
			left: reader.attr(bodyPr, "lIns") === undefined ? insets.left : reader.emu(bodyPr, "lIns", 0) / EMU_PER_PX,
			top: reader.attr(bodyPr, "tIns") === undefined ? insets.top : reader.emu(bodyPr, "tIns", 0) / EMU_PER_PX,
			right: reader.attr(bodyPr, "rIns") === undefined ? insets.right : reader.emu(bodyPr, "rIns", 0) / EMU_PER_PX,
			bottom: reader.attr(bodyPr, "bIns") === undefined ? insets.bottom : reader.emu(bodyPr, "bIns", 0) / EMU_PER_PX
		},
		anchor: isTextAnchor(anchor) ? anchor : (defaults.anchor ?? "t"),
		anchorCenter: reader.bool(bodyPr, "anchorCtr", defaults.anchorCenter ?? false),
		vertical: isTextVertical(vertical) ? vertical : (defaults.vertical ?? "horz"),
		wrap: reader.attr(bodyPr, "wrap") === undefined ? (defaults.wrap ?? true) : reader.attr(bodyPr, "wrap") !== "none",
		rotation: reader.angle(bodyPr, "rot", defaults.rotation ?? 0),
		upright: reader.bool(bodyPr, "upright", defaults.upright ?? false),
		columns: Math.max(1, reader.number(bodyPr, "numCol", defaults.columns ?? 1)),
		columnSpacing: reader.emu(bodyPr, "spcCol", 0) / EMU_PER_PX,
		autofit,
		fontScale: normal < 0 ? 1 : reader.fraction(normal, "fontScale", 1),
		lineSpacingReduction: normal < 0 ? 0 : reader.fraction(normal, "lnSpcReduction", 0)
	}
}

// A typeface attribute with theme references ("+mn-lt", "+mj-ea") resolved.
export function resolveTypeface(theme: DrawingTheme, typeface: string | undefined): string | undefined {
	if (typeface === undefined || typeface === "") return undefined
	if (!typeface.startsWith("+")) return typeface

	const fonts = typeface.startsWith("+mj") ? theme.majorFont : theme.minorFont
	const slot = typeface.slice(4)
	const resolved = slot === "ea" ? fonts.eastAsia : slot === "cs" ? fonts.complex : fonts.latin

	return resolved === "" ? undefined : resolved
}

interface RunProps {
	size: number
	bold: boolean
	italic: boolean
	underline: TextUnderline
	strike: TextRun["strike"]
	color: Rgba
	font: string
	baseline: number
	caps: TextRun["caps"]
	spacing: number
}

function applyRunProps(reader: DrawingReader, theme: DrawingTheme, node: number, into: RunProps): void {
	if (node < 0) return

	const size = reader.number(node, "sz", Number.NaN)

	if (!Number.isNaN(size) && size > 0) into.size = size / 100
	if (reader.attr(node, "b") !== undefined) into.bold = reader.bool(node, "b", false)
	if (reader.attr(node, "i") !== undefined) into.italic = reader.bool(node, "i", false)

	const underline = reader.attr(node, "u")

	if (underline !== undefined) into.underline = isTextUnderline(underline) ? underline : "none"

	const strike = reader.attr(node, "strike")

	if (strike === "noStrike" || strike === "sngStrike" || strike === "dblStrike") into.strike = strike

	const baseline = reader.attr(node, "baseline")

	if (baseline !== undefined) into.baseline = reader.fraction(node, "baseline", 0)

	const caps = reader.attr(node, "cap")

	if (caps === "none" || caps === "small" || caps === "all") into.caps = caps

	const spacing = reader.number(node, "spc", Number.NaN)

	if (!Number.isNaN(spacing)) into.spacing = spacing / 100

	const color = readColorIn(reader, reader.child(node, D.A, "solidFill"), theme)

	if (color !== undefined) into.color = color

	const font =
		resolveTypeface(theme, reader.attr(reader.child(node, D.A, "latin"), "typeface")) ??
		resolveTypeface(theme, reader.attr(reader.child(node, D.A, "ea"), "typeface"))

	if (font !== undefined) into.font = font
}

function levelProps(reader: DrawingReader, lstStyle: number, level: number): number {
	return reader.child(lstStyle, D.A, `lvl${level + 1}pPr`)
}

// Reads one a:txBody (or any element holding a:bodyPr, a:lstStyle and a:p children: dsp:txBody, c:rich,
// c:txPr). `extraStyles` are outer list styles, outermost first (a chart's c:txPr under the element's own).
export function readTextBody(
	reader: DrawingReader,
	theme: DrawingTheme,
	body: number,
	defaults: TextDefaults = DEFAULT_TEXT,
	bodyDefaults: Partial<TextBodyProps> = {},
	extraStyles: readonly { readonly reader: DrawingReader; readonly lstStyle: number; readonly defRPr: number }[] = []
): { readonly body: TextBodyProps; readonly paragraphs: TextParagraph[] } {
	const lstStyle = reader.child(body, D.A, "lstStyle")
	const paragraphs: TextParagraph[] = []

	for (const p of reader.children(body, D.A, "p")) {
		const pPr = reader.child(p, D.A, "pPr")
		const level = Math.max(0, Math.min(8, reader.number(pPr, "lvl", 0)))
		const levelNode = levelProps(reader, lstStyle, level)
		const base: RunProps = {
			size: defaults.size,
			bold: defaults.bold,
			italic: defaults.italic,
			underline: "none",
			strike: "noStrike",
			color: defaults.color,
			font: defaults.font,
			baseline: 0,
			caps: "none",
			spacing: 0
		}

		for (const style of extraStyles) {
			applyRunProps(style.reader, theme, style.defRPr, base)
			applyRunProps(style.reader, theme, style.reader.child(levelProps(style.reader, style.lstStyle, level), D.A, "defRPr"), base)
		}

		applyRunProps(reader, theme, reader.child(levelNode, D.A, "defRPr"), base)
		applyRunProps(reader, theme, reader.child(pPr, D.A, "defRPr"), base)

		const runs: TextRun[] = []
		const document = reader.document

		for (let child = document.firstChildElement(p); child >= 0; child = document.nextSiblingElement(child)) {
			if (reader.group(child) !== D.A) continue

			const local = document.localName(child)

			if (local !== "r" && local !== "br" && local !== "fld") continue

			const props = { ...base }

			applyRunProps(reader, theme, reader.child(child, D.A, "rPr"), props)
			runs.push({ ...props, text: local === "br" ? "" : reader.text(reader.child(child, D.A, "t")), lineBreak: local === "br" })
		}

		const endProps = { ...base }

		applyRunProps(reader, theme, reader.child(p, D.A, "endParaRPr"), endProps)

		const align = reader.attr(pPr, "algn") ?? reader.attr(levelNode, "algn")
		const spacing = (container: number): number => {
			const points = reader.child(container, D.A, "spcPts")

			if (points >= 0) return -reader.number(points, "val", 0) / 100

			const percent = reader.child(container, D.A, "spcPct")

			return percent < 0 ? 0 : reader.fraction(percent, "val", 1)
		}
		const lineSpacingNode =
			reader.child(pPr, D.A, "lnSpc") >= 0 ? reader.child(pPr, D.A, "lnSpc") : reader.child(levelNode, D.A, "lnSpc")
		const before = reader.child(pPr, D.A, "spcBef")
		const after = reader.child(pPr, D.A, "spcAft")
		const bulletChar = reader.child(pPr, D.A, "buChar") >= 0 ? reader.child(pPr, D.A, "buChar") : reader.child(levelNode, D.A, "buChar")
		const bulletNone = reader.child(pPr, D.A, "buNone") >= 0
		// A positive line spacing is a fraction of single; spcPts are negated points.
		const pointsOf = (container: number): number => {
			const value = spacing(container)

			return value < 0 ? -value : 0
		}

		paragraphs.push({
			align: isTextAlign(align) ? align : "l",
			level,
			marginLeft: reader.emu(pPr, "marL", reader.emu(levelNode, "marL", 0)) / EMU_PER_PX,
			indent: reader.emu(pPr, "indent", reader.emu(levelNode, "indent", 0)) / EMU_PER_PX,
			lineSpacing: lineSpacingNode < 0 ? 0 : spacing(lineSpacingNode),
			spaceBefore: before < 0 ? 0 : pointsOf(before),
			spaceAfter: after < 0 ? 0 : pointsOf(after),
			rtl: reader.bool(pPr, "rtl", false),
			bullet: bulletNone || bulletChar < 0 ? "" : (reader.attr(bulletChar, "char") ?? "").slice(0, 2),
			bulletFont: resolveTypeface(theme, reader.attr(reader.child(pPr, D.A, "buFont"), "typeface")) ?? "",
			runs,
			endSize: endProps.size
		})
	}

	return { body: readBodyProps(reader, reader.child(body, D.A, "bodyPr"), bodyDefaults), paragraphs }
}

// A single line of plain text with the given run properties (chart labels).
export function plainParagraph(text: string, props: TextDefaults, align: TextAlign = "ctr"): TextParagraph {
	const lines = text.split("\n")
	const runs: TextRun[] = []

	lines.forEach((line, index) => {
		if (index > 0) runs.push(plainRun("", props, true))

		runs.push(plainRun(line, props, false))
	})

	return {
		align,
		level: 0,
		marginLeft: 0,
		indent: 0,
		lineSpacing: 0,
		spaceBefore: 0,
		spaceAfter: 0,
		rtl: false,
		bullet: "",
		bulletFont: "",
		runs,
		endSize: props.size
	}
}

function plainRun(text: string, props: TextDefaults, lineBreak: boolean): TextRun {
	return {
		text,
		size: props.size,
		bold: props.bold,
		italic: props.italic,
		underline: "none",
		strike: "noStrike",
		color: props.color,
		font: props.font,
		baseline: 0,
		caps: "none",
		spacing: 0,
		lineBreak
	}
}
