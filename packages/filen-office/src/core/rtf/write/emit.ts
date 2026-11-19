import type { XmlDocument } from "../../xml/index"
import { languageIdentifier } from "../../docx/forms/dates"
import { BORDER_STYLES, UNDERLINES, textureWord } from "../props"
import { encodeText } from "./encode"
import { RtfOut, RtfWriteRefusal, joinChunks, latin1Bytes } from "./out"
import { OFF, TEXT, preserves } from "./wml"

// WordprocessingML paragraphs and table rows as RTF (Microsoft RTF Specification 1.9.1), the inverse of what the
// reader translates: every property spelled out after \pard\plain, every run in a group of its own starting with
// \plain, so a paragraph means the same wherever it lands. What the reader would not read back as it was
// written (an element or value it has no RTF for) is refused, never dropped.

export type NoteKind = "footnote" | "endnote"

// What the words refer to: table entries (added where the source has none), and source groups copied as they
// were (a note's, a picture's).
export interface EmitContext {
	readonly codepage: number
	font(name: string): number
	// "RRGGBB" or "auto".
	color(value: string): number
	style(id: string, type: "paragraph" | "character" | "table"): number
	list(numId: number): number
	author(name: string): number
	// Writes the group of note `id` of the part `kind`.
	note(kind: NoteKind, id: string, out: RtfOut): void
	// Writes comment `id` where its reference is: \\atnid, \\atnauthor, \\chatn and its \\annotation group.
	comment(id: string, out: RtfOut): void
	// The bookmark text of comment `id`'s \\atrfstart and \\atrfend (its \\atnref).
	commentTag(id: string): string
	// The source group of the picture a w:drawing shows (refuses one the edit changed).
	picture(document: XmlDocument, drawing: number): Uint8Array
	// The external target of a hyperlink relationship of `document`'s part.
	hyperlink(document: XmlDocument, id: string): string
}

function refuse(reason: string, detail?: string): never {
	throw new RtfWriteRefusal(reason, detail === undefined ? reason : `${reason}: ${detail}`)
}

function on(document: XmlDocument, node: number): boolean {
	const value = document.attribute(node, "w:val")

	return value === undefined || !OFF.has(value)
}

function int(document: XmlDocument, node: number, name: string): number | undefined {
	const value = document.attribute(node, name)

	if (value === undefined) return undefined

	const number = Number(value)

	if (!Number.isInteger(number)) refuse("value", `${document.name(node)}/@${name}="${value}"`)

	return number
}

// Attributes beyond `allowed` (namespace declarations aside) have no RTF.
function only(document: XmlDocument, node: number, allowed: readonly string[]): void {
	for (const attribute of document.attributes(node)) {
		const name = attribute.name

		if (name.startsWith("xmlns") || name.startsWith("w:rsid") || allowed.includes(name)) continue

		refuse("attribute", `${document.name(node)}/@${name}`)
	}
}

function children(document: XmlDocument, node: number): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) out.push(child)

	return out
}

const BORDER_WORDS = new Map<string, string>()

for (const [word, style] of BORDER_STYLES) if (!BORDER_WORDS.has(style)) BORDER_WORDS.set(style, word)

const UNDERLINE_WORDS = new Map<string, string>()

for (const [word, style] of UNDERLINES) if (!UNDERLINE_WORDS.has(style)) UNDERLINE_WORDS.set(style, word)

// A border's words after the word naming its side.
function border(document: XmlDocument, node: number, context: EmitContext, out: RtfOut): void {
	only(document, node, ["w:val", "w:sz", "w:space", "w:color"])

	const style = document.attribute(node, "w:val") ?? "single"

	if (style === "none" || style === "nil") {
		out.word(style === "none" ? "brdrnone" : "brdrnil")

		return
	}

	const word = BORDER_WORDS.get(style)

	if (word === undefined) refuse("border", style)

	out.word(word)

	const size = int(document, node, "w:sz")

	if (size !== undefined) out.word("brdrw", Math.round((size * 20) / 8))

	const space = int(document, node, "w:space")

	if (space !== undefined && space !== 0) out.word("brsp", space * 20)

	const color = document.attribute(node, "w:color")

	if (color !== undefined && color !== "auto") out.word("brdrcf", context.color(color))
}

// w:shd: the words for its fill, pattern colour and percentage (paragraph, character or cell).
function shading(
	document: XmlDocument,
	node: number,
	context: EmitContext,
	out: RtfOut,
	words: { readonly fill: string; readonly pattern: string; readonly percent: string; readonly texture: string }
): void {
	// Theme fills and colours mean their w:fill and w:color here (no theme: see rFonts).
	only(document, node, ["w:val", "w:color", "w:fill", ...THEME_FILL])

	const value = document.attribute(node, "w:val") ?? "clear"
	// A pattern (\\bghoriz...) or a percentage.
	const texture = textureWord(value, words.texture)
	const percent =
		texture !== undefined
			? 0
			: value === "clear"
				? 0
				: value === "solid"
					? 10000
					: /^pct(\d+)$/u.exec(value) === null
						? -1
						: Number(value.slice(3)) * 100

	if (percent < 0) refuse("shading", value)
	if (texture !== undefined) out.word(texture)

	const fill = document.attribute(node, "w:fill")
	const pattern = document.attribute(node, "w:color")

	if (fill !== undefined && fill !== "auto") out.word(words.fill, context.color(fill))
	if (pattern !== undefined && pattern !== "auto") out.word(words.pattern, context.color(pattern))
	if (percent !== 0) out.word(words.percent, percent)
}

const THEME_COLOR = ["w:themeColor", "w:themeShade", "w:themeTint"]
const THEME_FONT = ["w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"]
const THEME_FILL = ["w:themeFill", "w:themeFillShade", "w:themeFillTint", ...THEME_COLOR]

const CHAR_TOGGLES = new Map([
	["b", "b"],
	["bCs", "ab"],
	["i", "i"],
	["iCs", "ai"],
	["caps", "caps"],
	["smallCaps", "scaps"],
	["strike", "strike"],
	["dstrike", "striked"],
	["outline", "outl"],
	["shadow", "shad"],
	["emboss", "embo"],
	["imprint", "impr"],
	["noProof", "noproof"],
	["vanish", "v"],
	["webHidden", "webhidden"]
])

const EMPHASIS_WORDS = new Map([
	["none", "accnone"],
	["dot", "accdot"],
	["comma", "acccomma"],
	["circle", "acccircle"],
	["underDot", "accunderdot"]
])

const EFFECT_NUMBERS = new Map([
	["none", 0],
	["lights", 1],
	["blinkBackground", 2],
	["sparkle", 3],
	["antsBlack", 4],
	["antsRed", 5],
	["shimmer", 6]
])

const KASHIDA_LENGTHS = new Map([
	["lowKashida", 0],
	["mediumKashida", 10],
	["highKashida", 20]
])

const TEXT_ALIGNMENT_WORDS = new Map([
	["auto", "faauto"],
	["top", "fahang"],
	["center", "facenter"],
	["baseline", "faroman"],
	["bottom", "favar"]
])

// A w:lang value as a Windows language identifier (the reader writes them as four hex digits).
function languageWord(value: string): number {
	const lcid = languageIdentifier(value)

	return lcid === undefined ? refuse("language", value) : lcid
}

const HIGHLIGHT_COLORS = new Map([
	["black", "000000"],
	["blue", "0000FF"],
	["cyan", "00FFFF"],
	["green", "00FF00"],
	["magenta", "FF00FF"],
	["red", "FF0000"],
	["yellow", "FFFF00"],
	["white", "FFFFFF"],
	["darkBlue", "000080"],
	["darkCyan", "008080"],
	["darkGreen", "008000"],
	["darkMagenta", "800080"],
	["darkRed", "800000"],
	["darkYellow", "808000"],
	["darkGray", "808080"],
	["lightGray", "C0C0C0"]
])

// The words of a w:rPr (after \plain).
export function charWords(document: XmlDocument, rPr: number, context: EmitContext, out: RtfOut): void {
	for (const child of children(document, rPr)) {
		const local = document.localName(child)
		const toggle = CHAR_TOGGLES.get(local)

		if (toggle !== undefined) {
			only(document, child, ["w:val"])
			out.word(toggle, on(document, child) ? undefined : 0)

			continue
		}

		switch (local) {
			case "rStyle":
				out.word("cs", context.style(document.attribute(child, "w:val") ?? "", "character"))
				break
			case "rPrChange":
				oldProps(document, child, "oldcprops", "cr", context, out, inner => {
					out.word("plain")
					charWords(document, inner, context, out)
				})
				break
			case "ins":
			case "del":
				// The paragraph mark inserted or deleted (only a mark's properties hold these): the character revision
				// marks (RTF 1.9.1, "Revision Marks") in force at its \\par.
				only(document, child, ["w:id", "w:author", "w:date"])
				revisionWords(
					{
						kind: local,
						author: context.author(document.attribute(child, "w:author") ?? "Unknown"),
						date: toDttm(document.attribute(child, "w:date"))
					},
					out
				)
				break
			case "rFonts": {
				// w:hint="default" is what fonts without a hint do. A theme font names a slot of the document's theme
				// (ECMA-376 Part 1 §17.3.2.26); RTF keeps a theme only as \\themedata with \\flomajor... flags on font
				// entries (RTF 1.9.1, "Font Table"), and the translation has none: each slot shows its concrete face,
				// or the one it inherits where it names none. That face is what is written; the reference has no RTF.
				only(document, child, [
					"w:ascii",
					"w:hAnsi",
					"w:eastAsia",
					"w:cs",
					...THEME_FONT,
					...(document.attribute(child, "w:hint") === "default" ? ["w:hint"] : [])
				])

				const ascii = document.attribute(child, "w:ascii")
				const hAnsi = document.attribute(child, "w:hAnsi")
				const eastAsia = document.attribute(child, "w:eastAsia")
				const cs = document.attribute(child, "w:cs")

				if (ascii !== undefined) out.word("f", context.font(ascii))
				if (eastAsia !== undefined) out.word("dbch").word("af", context.font(eastAsia))
				if (hAnsi !== undefined && hAnsi !== ascii) out.word("hich").word("af", context.font(hAnsi))
				if (cs !== undefined) out.word("ltrch").word("af", context.font(cs))
				break
			}
			case "color": {
				// A theme colour means its w:val here: an RTF document has no theme (nor does its translation).
				only(document, child, ["w:val", ...THEME_COLOR])
				out.word("cf", context.color(document.attribute(child, "w:val") ?? "auto"))
				break
			}
			case "spacing":
				only(document, child, ["w:val"])
				out.word("expndtw", int(document, child, "w:val") ?? 0)
				break
			case "w":
				only(document, child, ["w:val"])
				out.word("charscalex", int(document, child, "w:val") ?? 100)
				break
			case "kern":
				only(document, child, ["w:val"])
				out.word("kerning", int(document, child, "w:val") ?? 0)
				break
			case "position": {
				only(document, child, ["w:val"])

				const value = int(document, child, "w:val") ?? 0

				out.word(value < 0 ? "dn" : "up", Math.abs(value))
				break
			}
			case "sz":
				only(document, child, ["w:val"])
				out.word("fs", int(document, child, "w:val") ?? 24)
				break
			case "szCs":
				only(document, child, ["w:val"])
				out.word("afs", int(document, child, "w:val") ?? 24)
				break
			case "highlight": {
				only(document, child, ["w:val"])

				const name = document.attribute(child, "w:val") ?? "none"

				if (name === "none") {
					out.word("highlight", 0)
					break
				}

				const color = HIGHLIGHT_COLORS.get(name)

				if (color === undefined) refuse("highlight", name)

				out.word("highlight", context.color(color))
				break
			}
			case "u": {
				only(document, child, ["w:val", "w:color"])

				const value = document.attribute(child, "w:val") ?? "single"
				const word = UNDERLINE_WORDS.get(value)

				if (word === undefined) refuse("underline", value)

				out.word(word)

				const color = document.attribute(child, "w:color")

				if (color !== undefined) out.word("ulc", context.color(color))
				break
			}
			case "bdr":
				out.word("chbrdr")
				border(document, child, context, out)
				break
			case "em": {
				only(document, child, ["w:val"])

				const value = document.attribute(child, "w:val") ?? "none"

				out.word(EMPHASIS_WORDS.get(value) ?? refuse("emphasis", value))
				break
			}
			case "effect": {
				only(document, child, ["w:val"])

				const value = document.attribute(child, "w:val") ?? "none"

				out.word("animtext", EFFECT_NUMBERS.get(value) ?? refuse("effect", value))
				break
			}
			case "lang": {
				only(document, child, ["w:val", "w:eastAsia", "w:bidi"])

				// Word writes each language with its \\langnp twin; so does this.
				const latin = document.attribute(child, "w:val")
				const eastAsia = document.attribute(child, "w:eastAsia")
				const bidi = document.attribute(child, "w:bidi")

				if (latin !== undefined) out.word("lang", languageWord(latin)).word("langnp", languageWord(latin))
				if (eastAsia !== undefined) out.word("langfe", languageWord(eastAsia)).word("langfenp", languageWord(eastAsia))
				if (bidi !== undefined) out.word("alang", languageWord(bidi))
				break
			}
			case "shd":
				shading(document, child, context, out, { fill: "chcbpat", pattern: "chcfpat", percent: "chshdng", texture: "chbg" })
				break
			case "vertAlign": {
				only(document, child, ["w:val"])

				const value = document.attribute(child, "w:val")

				out.word(
					value === "superscript"
						? "super"
						: value === "subscript"
							? "sub"
							: value === "baseline"
								? "nosupersub"
								: refuse("vertAlign", value)
				)
				break
			}
			default:
				refuse("runProperty", local)
		}
	}
}

const ALIGNMENT_WORDS = new Map([
	["left", "ql"],
	["start", "ql"],
	["right", "qr"],
	["end", "qr"],
	["center", "qc"],
	["both", "qj"],
	["distribute", "qd"],
	["thaiDistribute", "qt"]
])

const TAB_WORDS = new Map([
	["right", "tqr"],
	["center", "tqc"],
	["decimal", "tqdec"]
])

const LEADER_WORDS = new Map([
	["dot", "tldot"],
	["middleDot", "tlmdot"],
	["hyphen", "tlhyph"],
	["underscore", "tlul"],
	["heavy", "tlth"]
])

const PARA_TOGGLES = new Map<string, readonly [string | undefined, string | undefined]>([
	// [on, off]
	["keepNext", ["keepn", undefined]],
	["keepLines", ["keep", undefined]],
	["pageBreakBefore", ["pagebb", undefined]],
	["widowControl", ["widctlpar", "nowidctlpar"]],
	["suppressLineNumbers", ["noline", undefined]],
	["contextualSpacing", ["contextualspace", undefined]],
	["bidi", ["rtlpar", "ltrpar"]],
	["snapToGrid", [undefined, "nosnaplinegrid"]]
])

const PARA_BORDERS = new Map([
	["top", "brdrt"],
	["left", "brdrl"],
	["bottom", "brdrb"],
	["right", "brdrr"],
	["between", "brdrbtw"],
	["bar", "brdrbar"]
])

// The words of a w:pPr after \pard (its w:rPr and w:sectPr are the caller's).
export function paraWords(document: XmlDocument, pPr: number, context: EmitContext, out: RtfOut): void {
	for (const child of children(document, pPr)) {
		const local = document.localName(child)
		const toggle = PARA_TOGGLES.get(local)

		if (toggle !== undefined) {
			only(document, child, ["w:val"])

			const word = on(document, child) ? toggle[0] : toggle[1]

			if (word === undefined) refuse("paragraphProperty", `${local} ${on(document, child) ? "on" : "off"}`)

			out.word(word)

			continue
		}

		switch (local) {
			case "rPr":
			case "sectPr":
				break
			case "pPrChange":
				oldProps(document, child, "oldpprops", "pr", context, out, inner => {
					out.word("pard")
					paraWords(document, inner, context, out)
				})
				break
			case "pStyle":
				out.word("s", context.style(document.attribute(child, "w:val") ?? "", "paragraph"))
				break
			case "suppressAutoHyphens":
				only(document, child, ["w:val"])
				out.word("hyphpar", on(document, child) ? 0 : undefined)
				break
			case "overflowPunct":
				only(document, child, ["w:val"])
				out.word("nooverflow", on(document, child) ? 0 : undefined)
				break
			case "autoSpaceDE":
			case "autoSpaceDN":
			case "adjustRightInd":
				only(document, child, ["w:val"])
				out.word(
					local === "autoSpaceDE" ? "aspalpha" : local === "autoSpaceDN" ? "aspnum" : "adjustright",
					on(document, child) ? undefined : 0
				)
				break
			case "textAlignment": {
				only(document, child, ["w:val"])

				const value = document.attribute(child, "w:val") ?? ""

				out.word(TEXT_ALIGNMENT_WORDS.get(value) ?? refuse("textAlignment", value))
				break
			}
			case "framePr":
				frame(document, child, out)
				break
			case "numPr": {
				let level = 0
				let numId: number | undefined

				for (const part of children(document, child)) {
					const name = document.localName(part)

					if (name === "ilvl") level = int(document, part, "w:val") ?? 0
					else if (name === "numId") numId = int(document, part, "w:val")
					else refuse("numbering", name)
				}

				if (numId === undefined) refuse("numbering", "numPr without numId")

				out.word("ls", numId === 0 ? 0 : context.list(numId)).word("ilvl", level)
				break
			}
			case "pBdr":
				for (const side of children(document, child)) {
					const word = PARA_BORDERS.get(document.localName(side))

					if (word === undefined) refuse("border", document.localName(side))

					out.word(word)
					border(document, side, context, out)
				}
				break
			case "shd":
				shading(document, child, context, out, { fill: "cbpat", pattern: "cfpat", percent: "shading", texture: "bg" })
				break
			case "tabs":
				for (const tab of children(document, child)) {
					if (document.localName(tab) !== "tab") refuse("tab", document.localName(tab))

					only(document, tab, ["w:val", "w:leader", "w:pos"])

					const kind = document.attribute(tab, "w:val") ?? "left"
					const leader = document.attribute(tab, "w:leader")
					const position = int(document, tab, "w:pos") ?? 0

					if (leader !== undefined && leader !== "none") {
						const word = LEADER_WORDS.get(leader)

						if (word === undefined) refuse("tab", `leader ${leader}`)

						out.word(word)
					}

					if (kind === "bar") {
						out.word("tb", position)
					} else {
						if (kind !== "left" && kind !== "start") {
							const word = TAB_WORDS.get(kind === "end" ? "right" : kind)

							if (word === undefined) refuse("tab", kind)

							out.word(word)
						}

						out.word("tx", position)
					}
				}
				break
			case "spacing": {
				only(document, child, ["w:before", "w:after", "w:beforeAutospacing", "w:afterAutospacing", "w:line", "w:lineRule"])

				const before = int(document, child, "w:before")
				const after = int(document, child, "w:after")
				const beforeAuto = document.attribute(child, "w:beforeAutospacing")
				const afterAuto = document.attribute(child, "w:afterAutospacing")
				const line = int(document, child, "w:line")
				const rule = document.attribute(child, "w:lineRule") ?? "auto"

				if (before !== undefined) out.word("sb", before)
				if (beforeAuto !== undefined) out.word("sbauto", OFF.has(beforeAuto) ? 0 : 1)
				if (after !== undefined) out.word("sa", after)
				if (afterAuto !== undefined) out.word("saauto", OFF.has(afterAuto) ? 0 : 1)

				if (line !== undefined) {
					if (rule === "exact") out.word("sl", -line).word("slmult", 0)
					else if (rule === "atLeast") out.word("sl", line).word("slmult", 0)
					else out.word("sl", line).word("slmult", 1)
				}
				break
			}
			case "ind": {
				only(document, child, ["w:left", "w:start", "w:right", "w:end", "w:firstLine", "w:hanging"])

				const left = int(document, child, "w:left") ?? int(document, child, "w:start")
				const right = int(document, child, "w:right") ?? int(document, child, "w:end")
				const firstLine = int(document, child, "w:firstLine")
				const hanging = int(document, child, "w:hanging")

				if (left !== undefined) out.word("li", left)
				if (right !== undefined) out.word("ri", right)
				if (hanging !== undefined) out.word("fi", -hanging)
				else if (firstLine !== undefined) out.word("fi", firstLine)
				break
			}
			case "jc": {
				only(document, child, ["w:val"])

				const kashida = KASHIDA_LENGTHS.get(document.attribute(child, "w:val") ?? "")

				if (kashida !== undefined) {
					out.word("qk", kashida)
					break
				}

				const word = ALIGNMENT_WORDS.get(document.attribute(child, "w:val") ?? "")

				if (word === undefined) refuse("alignment", document.attribute(child, "w:val"))

				out.word(word)
				break
			}
			case "outlineLvl":
				only(document, child, ["w:val"])
				out.word("outlinelevel", int(document, child, "w:val") ?? 0)
				break
			default:
				refuse("paragraphProperty", local)
		}
	}
}

const X_ALIGN = new Map([
	["center", "posxc"],
	["inside", "posxi"],
	["outside", "posxo"],
	["right", "posxr"],
	["left", "posxl"]
])

const Y_ALIGN = new Map([
	["inline", "posyil"],
	["top", "posyt"],
	["center", "posyc"],
	["bottom", "posyb"],
	["inside", "posyin"],
	["outside", "posyout"]
])

const WRAP_WORDS = new Map([
	["notBeside", "nowrap"],
	["none", "overlay"],
	["around", "wraparound"],
	["tight", "wraptight"],
	["through", "wrapthrough"],
	["auto", "wrapdefault"]
])

function frame(document: XmlDocument, node: number, out: RtfOut): void {
	only(document, node, [
		"w:dropCap",
		"w:lines",
		"w:w",
		"w:h",
		"w:hRule",
		"w:hSpace",
		"w:vSpace",
		"w:wrap",
		"w:hAnchor",
		"w:vAnchor",
		"w:x",
		"w:xAlign",
		"w:y",
		"w:yAlign"
	])

	const height = int(document, node, "w:h") ?? 0
	const rule = document.attribute(node, "w:hRule") ?? "auto"

	out.word("absw", int(document, node, "w:w") ?? 0)
	if (height !== 0) out.word("absh", rule === "exact" ? -height : height)

	const hSpace = int(document, node, "w:hSpace")
	const vSpace = int(document, node, "w:vSpace")

	if (hSpace !== undefined) out.word("dfrmtxtx", hSpace)
	if (vSpace !== undefined) out.word("dfrmtxty", vSpace)

	const hAnchor = document.attribute(node, "w:hAnchor") ?? "text"
	const vAnchor = document.attribute(node, "w:vAnchor") ?? "margin"

	out.word(hAnchor === "margin" ? "phmrg" : hAnchor === "page" ? "phpg" : "phcol")
	out.word(vAnchor === "margin" ? "pvmrg" : vAnchor === "page" ? "pvpg" : "pvpara")

	const xAlign = document.attribute(node, "w:xAlign")
	const yAlign = document.attribute(node, "w:yAlign")

	if (xAlign !== undefined) out.word(X_ALIGN.get(xAlign) ?? refuse("frame", `xAlign ${xAlign}`))
	else out.word("posx", int(document, node, "w:x") ?? 0)

	if (yAlign !== undefined) out.word(Y_ALIGN.get(yAlign) ?? refuse("frame", `yAlign ${yAlign}`))
	else out.word("posy", int(document, node, "w:y") ?? 0)

	const dropCap = document.attribute(node, "w:dropCap")

	if (dropCap !== undefined && dropCap !== "none") {
		out.word("dropcapli", int(document, node, "w:lines") ?? 1).word("dropcapt", dropCap === "margin" ? 2 : 1)
	}

	const wrap = document.attribute(node, "w:wrap") ?? "auto"

	out.word(WRAP_WORDS.get(wrap) ?? refuse("frame", `wrap ${wrap}`))
}

// ---- content

interface Revision {
	readonly kind: "ins" | "del"
	readonly author: number
	readonly date: number
}

// A DTTM (minutes precision) from an ISO 8601 time; 0 for none.
export function toDttm(value: string | undefined): number {
	if (value === undefined) return 0

	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(value)

	if (match === null) return 0

	const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]

	if (year < 1900 || year > 2411) return 0

	return (minute | (hour << 6) | (day << 11) | (month << 16) | ((year - 1900) << 20)) >>> 0
}

type Item =
	| {
			readonly kind: "text"
			readonly rPr: number
			readonly revision: Revision | undefined
			readonly text: string
			readonly instr: boolean
	  }
	| { readonly kind: "atom"; readonly rPr: number; readonly revision: Revision | undefined; readonly words: string }
	| {
			readonly kind: "field"
			readonly rPr: number
			readonly revision: Revision | undefined
			readonly type: "begin" | "separate" | "end"
			readonly lock: boolean
			readonly dirty: boolean
	  }
	| { readonly kind: "bookmark"; readonly start: boolean; readonly name: string }
	| {
			readonly kind: "note"
			readonly rPr: number
			readonly revision: Revision | undefined
			readonly note: NoteKind
			readonly id: string
			readonly custom: boolean
	  }
	| { readonly kind: "noteMark"; readonly rPr: number; readonly revision: Revision | undefined }
	| { readonly kind: "commentRange"; readonly start: boolean; readonly id: string }
	| { readonly kind: "comment"; readonly rPr: number; readonly revision: Revision | undefined; readonly id: string }
	| { readonly kind: "commentMark"; readonly rPr: number; readonly revision: Revision | undefined }
	| { readonly kind: "picture"; readonly rPr: number; readonly revision: Revision | undefined; readonly bytes: Uint8Array }

class Content {
	readonly items: Item[] = []
	private readonly bookmarks = new Map<string, string>()

	private readonly document: XmlDocument
	private readonly context: EmitContext

	constructor(document: XmlDocument, context: EmitContext, bookmarks: Map<string, string>) {
		this.document = document
		this.context = context
		this.bookmarks = bookmarks
	}

	walk(node: number, revision: Revision | undefined): void {
		const document = this.document

		for (const child of children(document, node)) {
			const local = document.localName(child)

			switch (local) {
				case "pPr":
				case "proofErr":
				case "lastRenderedPageBreak":
				case "permStart":
				case "permEnd":
					break
				case "r":
					this.run(child, revision)
					break
				case "ins":
				case "del": {
					only(document, child, ["w:id", "w:author", "w:date"])

					if (revision !== undefined) refuse("revision", "nested")

					this.walk(child, {
						kind: local,
						author: this.context.author(document.attribute(child, "w:author") ?? "Unknown"),
						date: toDttm(document.attribute(child, "w:date"))
					})
					break
				}
				case "hyperlink": {
					// A HYPERLINK field: what the reader reads a link as.
					only(document, child, ["r:id", "w:anchor", "w:history", "w:tgtFrame"])

					const id = document.attribute(child, "r:id")
					const anchor = document.attribute(child, "w:anchor")
					const frame = document.attribute(child, "w:tgtFrame")
					let instruction = "HYPERLINK"

					if (id !== undefined) instruction += ` ${quoted(this.context.hyperlink(document, id))}`
					if (anchor !== undefined) instruction += ` \\l ${quoted(anchor)}`
					if (frame !== undefined) instruction += ` \\t ${quoted(frame)}`

					const field = { kind: "field", rPr: -1, revision, lock: false, dirty: false } as const

					this.items.push({ ...field, type: "begin" })
					this.items.push({ kind: "text", rPr: -1, revision, text: instruction, instr: true })
					this.items.push({ ...field, type: "separate" })
					this.walk(child, revision)
					this.items.push({ ...field, type: "end" })
					break
				}
				case "bookmarkStart": {
					const name = document.attribute(child, "w:name") ?? ""
					const id = document.attribute(child, "w:id")

					if (id !== undefined) this.bookmarks.set(id, name)

					this.items.push({ kind: "bookmark", start: true, name })
					break
				}
				case "commentRangeStart":
				case "commentRangeEnd":
					only(document, child, ["w:id"])
					this.items.push({
						kind: "commentRange",
						start: local === "commentRangeStart",
						id: document.attribute(child, "w:id") ?? ""
					})
					break
				case "bookmarkEnd": {
					const name = this.bookmarks.get(document.attribute(child, "w:id") ?? "")

					if (name === undefined) refuse("bookmark", "an end without its start")

					this.items.push({ kind: "bookmark", start: false, name })
					break
				}
				default:
					refuse("content", local)
			}
		}
	}

	private run(run: number, revision: Revision | undefined): void {
		const document = this.document
		let rPr = -1

		for (const child of children(document, run)) {
			const local = document.localName(child)

			if (local === "rPr") {
				rPr = child

				continue
			}

			if (TEXT.has(local)) {
				if (local.startsWith("del") !== (revision?.kind === "del")) refuse("revision", `${local} outside its deletion`)

				const raw = document.textContent(child)
				const text = preserves(document, child) ? raw : raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "")

				for (let k = 0; k < text.length; k++) {
					const code = text.charCodeAt(k)

					if (code < 0x20 && code !== 0x09) refuse("character", `U+${code.toString(16)}`)
				}

				if (text !== "") this.items.push({ kind: "text", rPr, revision, text, instr: local.endsWith("nstrText") })

				continue
			}

			switch (local) {
				case "tab":
					this.items.push({ kind: "atom", rPr, revision, words: "\\tab" })
					break
				case "br": {
					only(document, child, ["w:type", "w:clear"])

					const type = document.attribute(child, "w:type") ?? "textWrapping"
					const clear = document.attribute(child, "w:clear")

					if (type === "page") this.items.push({ kind: "atom", rPr, revision, words: "\\page" })
					else if (type === "column") this.items.push({ kind: "atom", rPr, revision, words: "\\column" })
					else if (clear !== undefined) {
						const index = ["none", "left", "right", "all"].indexOf(clear)

						if (index < 0) refuse("break", clear)

						this.items.push({ kind: "atom", rPr, revision, words: `\\lbr${index}` })
					} else this.items.push({ kind: "atom", rPr, revision, words: "\\line" })
					break
				}
				case "fldChar": {
					only(document, child, ["w:fldCharType", "w:fldLock", "w:dirty"])

					const type = document.attribute(child, "w:fldCharType")

					if (type !== "begin" && type !== "separate" && type !== "end") refuse("field", type)

					this.items.push({
						kind: "field",
						rPr,
						revision,
						type,
						lock: document.attribute(child, "w:fldLock") === "1",
						dirty: document.attribute(child, "w:dirty") === "1"
					})
					break
				}
				case "footnoteReference":
				case "endnoteReference":
					only(document, child, ["w:id", "w:customMarkFollows"])
					this.items.push({
						kind: "note",
						rPr,
						revision,
						note: local === "footnoteReference" ? "footnote" : "endnote",
						id: document.attribute(child, "w:id") ?? "",
						custom: document.attribute(child, "w:customMarkFollows") === "1"
					})
					break
				case "footnoteRef":
				case "endnoteRef":
					this.items.push({ kind: "noteMark", rPr, revision })
					break
				case "commentReference":
					only(document, child, ["w:id"])
					this.items.push({ kind: "comment", rPr, revision, id: document.attribute(child, "w:id") ?? "" })
					break
				case "annotationRef":
					this.items.push({ kind: "commentMark", rPr, revision })
					break
				case "drawing":
					this.items.push({ kind: "picture", rPr, revision, bytes: this.context.picture(document, child) })
					break
				case "sym":
					// Only a SYMBOL field's computed result (written by the reader where the field shows nothing).
					this.items.push({ kind: "atom", rPr, revision, words: "" })
					break
				case "lastRenderedPageBreak":
					break
				case "softHyphen":
					this.items.push({ kind: "text", rPr, revision, text: "\u00ad", instr: false })
					break
				case "noBreakHyphen":
					this.items.push({ kind: "text", rPr, revision, text: "\u2011", instr: false })
					break
				default:
					refuse("content", local)
			}
		}
	}
}

// A tracked formatting change as old properties (RTF 1.9.1, "Old Properties"): the words that give the properties
// before it (written by `words` from the change's inner properties, which may be absent: none), then its author and
// date (\\crauthN and \\crdateN, or the paragraph's \\pr, section's \\sr words).
function oldProps(
	document: XmlDocument,
	change: number,
	name: "oldcprops" | "oldpprops" | "oldsprops",
	prefix: "cr" | "pr" | "sr",
	context: EmitContext,
	out: RtfOut,
	words: (inner: number) => void
): void {
	only(document, change, ["w:id", "w:author", "w:date"])

	const date = toDttm(document.attribute(change, "w:date"))

	out.rtf("{\\*").word(name)
	words(children(document, change)[0] ?? -1)
	out.word(`${prefix}auth`, context.author(document.attribute(change, "w:author") ?? "Unknown"))
	if (date !== 0) out.word(`${prefix}date`, date)
	out.rtf("}")
}

// The run properties and revision of an item, as words after \plain.
function runWords(document: XmlDocument, rPr: number, revision: Revision | undefined, context: EmitContext, out: RtfOut): void {
	if (rPr >= 0) charWords(document, rPr, context, out)
	if (revision !== undefined) revisionWords(revision, out)
}

function revisionWords(revision: Revision, out: RtfOut): void {
	if (revision.kind === "ins") {
		out.word("revised").word("revauth", revision.author)
		if (revision.date !== 0) out.word("revdttm", revision.date)
	} else {
		out.word("deleted").word("revauthdel", revision.author)
		if (revision.date !== 0) out.word("revdttmdel", revision.date)
	}
}

// The items of a paragraph's content as RTF, fields as \field groups (one paragraph's fields must close in it).
function writeItems(document: XmlDocument, items: readonly Item[], context: EmitContext, out: RtfOut): void {
	// Each field's end item, for the properties the reader gives it (those of the group around the field).
	const ends = new Map<number, number>()
	const open: number[] = []
	const state: ("instr" | "result")[] = []
	const symbols: boolean[] = []

	items.forEach((item, index) => {
		if (item.kind !== "field") return

		if (item.type === "begin") open.push(index)
		else if (item.type === "end") {
			const begin = open.pop()

			if (begin === undefined) refuse("field", "an end without its start in the paragraph")

			ends.set(begin, index)
		}
	})

	if (open.length > 0) refuse("field", "a field running past its paragraph")

	let instruction = ""

	for (const [index, item] of items.entries()) {
		switch (item.kind) {
			case "text": {
				const inInstr = state.at(-1) === "instr"

				if (item.instr !== inInstr) refuse("field", item.instr ? "instruction text outside a field" : "text in a field instruction")

				if (inInstr) instruction += item.text

				const encoded = encodeText(item.text, context.codepage)

				out.rtf("{").word("plain")
				if (encoded.unicode) out.word("uc", 1)
				runWords(document, item.rPr, item.revision, context, out)
				out.bytes(latin1Bytes(encoded.rtf)).rtf("}")
				break
			}
			case "atom":
				if (item.words === "") {
					// A w:sym: the reader computes it again from its SYMBOL field with an empty result.
					if (state.at(-1) !== "result" || symbols.at(-1) !== true) refuse("content", "sym outside a SYMBOL field")
					break
				}
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				out.word(item.words.slice(1)).rtf("}")
				break
			case "field": {
				if (item.type === "begin") {
					const end = items[ends.get(index) ?? -1]

					out.rtf("{").word("plain")
					if (end !== undefined && end.kind === "field") runWords(document, end.rPr, end.revision, context, out)
					out.rtf("{").word("field")
					if (item.lock) out.word("fldlock")
					if (item.dirty) out.word("flddirty")
					out.word("plain")
					runWords(document, item.rPr, item.revision, context, out)
					out.rtf("{\\*").word("fldinst")
					state.push("instr")
					symbols.push(false)
					instruction = ""
				} else if (item.type === "separate") {
					if (state.at(-1) !== "instr") refuse("field", "a second separator")

					symbols[symbols.length - 1] = /^\s*SYMBOL\s/iu.test(instruction)
					out.rtf("}").word("plain")
					runWords(document, item.rPr, item.revision, context, out)
					out.rtf("{").word("fldrslt")
					state[state.length - 1] = "result"
				} else {
					state.pop()
					symbols.pop()
					out.rtf("}}}")
				}
				break
			}
			case "bookmark": {
				if (state.at(-1) === "instr") refuse("bookmark", "in a field instruction")

				const encoded = encodeText(item.name, context.codepage)

				out.rtf("{\\*").word(item.start ? "bkmkstart" : "bkmkend")
				if (encoded.unicode) out.word("uc", 1)
				out.bytes(latin1Bytes(encoded.rtf)).rtf("}")
				break
			}
			case "note":
				if (state.length > 0) refuse("note", "in a field")
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				if (!item.custom) out.word("chftn")
				context.note(item.note, item.id, out)
				out.rtf("}")
				break
			case "noteMark":
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				out.word("chftn").rtf("}")
				break
			case "commentRange": {
				// RTF 1.9.1, "Comments (Annotations)": the range a comment covers, by the text its \\atnref has.
				if (state.length > 0) refuse("comment", "a comment's range in a field")

				const encoded = encodeText(context.commentTag(item.id), context.codepage)

				out.rtf("{\\*").word(item.start ? "atrfstart" : "atrfend")
				if (encoded.unicode) out.word("uc", 1)
				out.bytes(latin1Bytes(encoded.rtf)).rtf("}")
				break
			}
			case "comment":
				if (state.length > 0) refuse("comment", "in a field")
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				context.comment(item.id, out)
				out.rtf("}")
				break
			case "commentMark":
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				out.word("chatn").rtf("}")
				break
			case "picture":
				out.rtf("{").word("plain")
				runWords(document, item.rPr, item.revision, context, out)
				out.bytes(item.bytes).rtf("}")
				break
		}
	}
}

// A field argument in quotes (a quote in it has no form the field reader takes).
function quoted(value: string): string {
	if (value.includes('"')) refuse("hyperlink", "a quote in its target")

	return `"${value.replace(/\\/gu, "\\\\")}"`
}

export interface ParagraphPlace {
	// Table nesting depth (0 outside a table).
	readonly depth: number
	// What ends it: a word ("par", "cell", "nestcell") or source bytes (a \sect as it was).
	readonly term: string | Uint8Array | ((out: RtfOut) => void)
}

// A w:p as RTF: \pard\plain, its properties, its content, its mark's properties, what ends it.
export function writeParagraph(
	document: XmlDocument,
	paragraph: number,
	place: ParagraphPlace,
	context: EmitContext,
	out: RtfOut,
	bookmarks: Map<string, string> = new Map()
): void {
	only(document, paragraph, ["w14:paraId", "w14:textId"])

	let pPr = -1
	let mark = -1

	for (const child of children(document, paragraph)) {
		if (document.localName(child) !== "pPr") continue

		pPr = child

		for (const property of children(document, child)) if (document.localName(property) === "rPr") mark = property
	}

	// In a group of its own: what it sets ends with it, whenever a reader applies paragraph properties (at \\par,
	// as the specification says, or where the text starts).
	out.rtf("{").word("pard").word("plain")
	if (place.depth >= 1) out.word("intbl")
	if (place.depth >= 2) out.word("itap", place.depth)
	if (pPr >= 0) paraWords(document, pPr, context, out)

	const content = new Content(document, context, bookmarks)

	content.walk(paragraph, undefined)
	writeItems(document, content.items, context, out)

	if (mark >= 0) {
		out.word("plain")
		charWords(document, mark, context, out)
	}

	if (typeof place.term === "string") out.word(place.term)
	else if (typeof place.term === "function") place.term(out)
	else out.bytes(place.term)

	// A nested cell's paragraph mark for readers without nested tables, as Word writes it (RTF 1.9.1, "Tables").
	if (place.term === "nestcell") nonNested(out)

	out.rtf("}")
}

// ---- table rows

const ROW_BORDERS = new Map([
	["top", "trbrdrt"],
	["left", "trbrdrl"],
	["bottom", "trbrdrb"],
	["right", "trbrdrr"],
	["insideH", "trbrdrh"],
	["insideV", "trbrdrv"]
])

const CELL_BORDERS = new Map([
	["top", "clbrdrt"],
	["left", "clbrdrl"],
	["bottom", "clbrdrb"],
	["right", "clbrdrr"]
])

// Word writes \clpadt for the left padding and \clpadl for the top (the reader reads them so).
const CELL_PADDING = new Map([
	["top", "clpadl"],
	["left", "clpadt"],
	["bottom", "clpadb"],
	["right", "clpadr"]
])

function width(document: XmlDocument, node: number): { readonly w: number; readonly type: string } {
	return { w: int(document, node, "w:w") ?? 0, type: document.attribute(node, "w:type") ?? "dxa" }
}

// A preferred width's words (\\clftsWidthN and \\clwWidthN, or \\trftsWidthBN and \\trwWidthBN...): RTF 1.9.1's units are
// 1 auto, 2 fiftieths of a percent, 3 twips; w:type nil has none.
function preferredWidth(document: XmlDocument, node: number, unit: string, value: string, out: RtfOut): void {
	const { w, type } = width(document, node)

	if (type === "dxa") out.word(unit, 3).word(value, w)
	else if (type === "pct") out.word(unit, 2).word(value, w)
	else if (type === "auto") {
		out.word(unit, 1)
		if (w !== 0) out.word(value, w)
	} else refuse("width", `${document.name(node)} ${type}`)
}

// What a row written into a source table restates from the source's rows: words its translation does not hold.
export interface SourceTableWords {
	// \\tblindN and \\tblindtypeN: `relative`, the source's \\tblindN less its \\trleftN (an indent in twips, which
	// one version of Word measures to the text and another to the cell's edge); else the source's value as it was.
	readonly indent?: { readonly relative: boolean; readonly value: number; readonly type: number }
	// \\tsN naming a table style the style sheet does not have.
	readonly style?: number
}

// A w:tr of a table whose w:tblPr is `tblPr` as RTF: \trowd, the row's and its cells' definitions, each cell's
// paragraphs (written by `cell`, which ends the last with \cell), \row.
// A table's rows as RTF (\trowd, row and cell definitions, \cellxN, the cells' blocks, \row; at a nesting depth past 1
// the cells end with \nestcell and the row's definitions go in {\*\nesttableprops ... \nestrow}: RTF 1.9.1, "Tables").
// `base`: the left edge of the table's grid where the source has one (its rows' least \trleftN); else the table's
// indent less its leading cell margin. Each cell's right edge comes from the grid (its w:gridSpan columns). A cell
// spanning columns is one cell whose \cellxN is the span's right edge, as Word and LibreOffice write it, where other
// rows of the table have a cell edge at each column inside the span (a reader's grid is every row's edges); else it is
// \clmgf and one \clmrg cell per further column, so readers keep the grid.
export interface RowWriter {
	// Writes a cell's blocks (its paragraphs, nested tables) at `depth`, the last paragraph ending the cell.
	cell(tc: number, depth: number, out: RtfOut): void
}

export function writeRow(
	document: XmlDocument,
	tblPr: number,
	row: number,
	context: EmitContext,
	out: RtfOut,
	writer: RowWriter,
	depth = 1,
	base?: number,
	source?: SourceTableWords
): void {
	const tcs: number[] = []
	let trPr = -1
	let tblPrEx = -1

	for (const child of children(document, row)) {
		const local = document.localName(child)

		if (local === "tc") tcs.push(child)
		else if (local === "trPr") trPr = child
		else if (local === "tblPrEx") tblPrEx = child
		else refuse("tableContent", local)
	}

	const view: RowView = {
		tblPr,
		tblPrEx,
		trPr,
		tcPrs: tcs.map(tc => children(document, tc).find(child => document.localName(child) === "tcPr") ?? -1),
		grid: gridOf(document, tblPr)
	}
	const defs = new RtfOut()
	const spans = rowDefinition(document, view, context, defs, base, source, dividedEdges(document, row, view.grid.length))
	const change = rowChange(document, view)

	if (change !== undefined) {
		// Old properties (RTF 1.9.1, "Old Properties"): the row as it was defined, \\trauthN and \\trdateN ("Table Row
		// Revision Tracking") naming who changed it and when.
		defs.rtf("{\\*").word("oldtprops")
		rowDefinition(document, change.view, context, defs, indentOf(document, change.view.tblPr) === undefined ? base : undefined)
		defs.word("trauth", context.author(change.author))
		if (change.date !== 0) defs.word("trdate", change.date)
		defs.rtf("}")
	}

	const definitions = (target: RtfOut): void => {
		for (const chunk of defs.finish()) target.bytes(chunk)
	}

	if (depth <= 1) definitions(out)

	tcs.forEach((tc, k) => {
		writer.cell(tc, depth, out)

		// The cells merged into it: empty.
		for (let more = 1; more < (spans[k] ?? 1); more++) {
			out.rtf("{").word("pard").word("plain").word("intbl")
			if (depth >= 2) out.word("itap", depth)
			out.word(depth >= 2 ? "nestcell" : "cell").rtf("}")
		}
	})

	if (depth <= 1) {
		out.word("row")
	} else {
		out.rtf("{\\*").word("nesttableprops")
		definitions(out)
		out.word("nestrow").rtf("}")
		nonNested(out)
	}
}

// {\\nonesttables\\par}: what readers that do not understand nested tables read in their place, a paragraph mark
// ending the nested cell's or row's text (readers that do ignore it).
function nonNested(out: RtfOut): void {
	out.rtf("{").word("nonesttables").word("par").rtf("}")
}

// A row's properties as one definition reads them: the table's, the row's, each cell's, on the table's grid.
interface RowView {
	readonly tblPr: number
	// The row's exceptions to the table's properties (its shading alone).
	readonly tblPrEx: number
	readonly trPr: number
	readonly tcPrs: readonly number[]
	readonly grid: readonly number[]
}

function indentOf(document: XmlDocument, tblPr: number): number | undefined {
	const indent = tblPr < 0 ? undefined : children(document, tblPr).find(child => document.localName(child) === "tblInd")

	return indent === undefined ? undefined : width(document, indent).w
}

// The row as it was before its tracked property changes (w:tblPrChange, w:tblGridChange, w:trPrChange,
// w:tcPrChange), and who made them when; undefined when it has none.
function rowChange(document: XmlDocument, view: RowView): { view: RowView; author: string; date: number } | undefined {
	const changeOf = (node: number, name: string): number =>
		node < 0 ? -1 : (children(document, node).find(child => document.localName(child) === name) ?? -1)
	const innerOf = (change: number, name: string, fallback: number): number => (change < 0 ? fallback : changeOf(change, name))
	const table = view.tblPr < 0 ? -1 : document.parent(view.tblPr)
	const tblGrid = table < 0 ? -1 : changeOf(table, "tblGrid")
	const tblPrChange = changeOf(view.tblPr, "tblPrChange")
	const gridChange = changeOf(tblGrid, "tblGridChange")
	const trPrChange = changeOf(view.trPr, "trPrChange")
	const tcPrChanges = view.tcPrs.map(tcPr => changeOf(tcPr, "tcPrChange"))
	const changes = [tblPrChange, trPrChange, ...tcPrChanges].filter(change => change >= 0)

	if (changes.length === 0 && gridChange < 0) return undefined

	const who = new Set<string>()

	for (const change of changes) {
		only(document, change, ["w:id", "w:author", "w:date"])
		who.add(`${document.attribute(change, "w:author") ?? "Unknown"}\u0000${toDttm(document.attribute(change, "w:date"))}`)
	}

	if (who.size > 1)
		refuse(
			"rowRevision",
			"row changes by different authors or at different times (RTF 1.9.1 gives a row's old properties one \\trauthN and \\trdateN)"
		)

	const first = changes[0]
	const oldGrid = gridChange < 0 ? -1 : changeOf(gridChange, "tblGrid")

	return {
		view: {
			tblPr: innerOf(tblPrChange, "tblPr", view.tblPr),
			tblPrEx: view.tblPrEx,
			trPr: innerOf(trPrChange, "trPr", view.trPr),
			tcPrs: view.tcPrs.map((tcPr, k) => innerOf(tcPrChanges[k] ?? -1, "tcPr", tcPr)),
			grid: oldGrid < 0 ? view.grid : children(document, oldGrid).map(column => int(document, column, "w:w") ?? 0)
		},
		author: first === undefined ? "Unknown" : (document.attribute(first, "w:author") ?? "Unknown"),
		date: first === undefined ? 0 : toDttm(document.attribute(first, "w:date"))
	}
}

// \\trowd, the row's words and each cell's, ending with its \\cellx; returns the grid columns each cell spans.
function rowDefinition(
	document: XmlDocument,
	view: RowView,
	context: EmitContext,
	out: RtfOut,
	base: number | undefined,
	source?: SourceTableWords,
	divided?: Uint32Array
): number[] {
	out.word("trowd")

	let marginLeft: number | undefined
	let marginRight: number | undefined
	let indent: number | undefined
	let autofit = true
	let styled = false
	let shd = -1

	for (const child of view.tblPr < 0 ? [] : children(document, view.tblPr)) {
		const local = document.localName(child)

		switch (local) {
			case "tblStyle":
				out.word("ts", context.style(document.attribute(child, "w:val") ?? "", "table"))
				styled = true
				break
			case "shd":
				shd = child
				break
			case "bidiVisual":
				out.word("taprtl")
				break
			case "tblW": {
				const { w, type } = width(document, child)

				if (type === "dxa" && w > 0) out.word("trftsWidth", 3).word("trwWidth", w)
				else if (type === "pct" && w > 0) out.word("trftsWidth", 2).word("trwWidth", w)
				break
			}
			case "jc": {
				const value = document.attribute(child, "w:val")

				if (value === "center") out.word("trqc")
				else if (value === "right" || value === "end") out.word("trqr")
				else if (value !== "left" && value !== "start") refuse("tableProperty", `jc ${value}`)
				break
			}
			case "tblInd":
				indent = width(document, child).w
				break
			case "tblBorders":
				for (const side of children(document, child)) {
					const local = document.localName(side)
					const word = ROW_BORDERS.get(local === "start" ? "left" : local === "end" ? "right" : local)

					if (word === undefined) refuse("border", local)

					out.word(word)
					border(document, side, context, out)
				}
				break
			case "tblLayout":
				autofit = document.attribute(child, "w:type") !== "fixed"
				break
			case "tblCellMar":
				for (const side of children(document, child)) {
					const name = document.localName(side)
					const value = width(document, side).w

					if (name === "left" || name === "start") marginLeft = value
					else if (name === "right" || name === "end") marginRight = value
					else if (name === "top") out.word("trpaddt", value).word("trpaddft", 3)
					else if (name === "bottom") out.word("trpaddb", value).word("trpaddfb", 3)
					else refuse("tableProperty", `tblCellMar ${name}`)
				}
				break
			case "tblLook": {
				// Which of a table style's conditional formats apply (RTF 1.9.1 <tflags>).
				const value = parseInt(document.attribute(child, "w:val") ?? "0", 16)
				const flag = (attribute: string, bit: number): boolean => {
					const given = document.attribute(child, attribute)

					return given === undefined ? (value & bit) !== 0 : given === "1" || given === "true"
				}

				if (flag("w:firstRow", 0x20)) out.word("tbllkhdrrows")
				if (flag("w:lastRow", 0x40)) out.word("tbllklastrow")
				if (flag("w:firstColumn", 0x80)) out.word("tbllkhdrcols")
				if (flag("w:lastColumn", 0x100)) out.word("tbllklastcol")
				if (flag("w:noHBand", 0x200)) out.word("tbllknorowband")
				if (flag("w:noVBand", 0x400)) out.word("tbllknocolband")
				break
			}
			case "tblPrChange":
				// The old properties (rowChange).
				break
			default:
				refuse("tableProperty", local)
		}
	}

	for (const child of view.tblPrEx < 0 ? [] : children(document, view.tblPrEx)) {
		const local = document.localName(child)

		if (local === "shd") shd = child
		else refuse("tableProperty", `tblPrEx ${local}`)
	}

	// Row shading (RTF 1.9.1 "Row Shading and Background Color").
	if (shd >= 0) shading(document, shd, context, out, { fill: "trcbpat", pattern: "trcfpat", percent: "trshdng", texture: "trbg" })
	if (!styled && source?.style !== undefined) out.word("ts", source.style)

	// Margins no layer gives take the standard's default (ISO/IEC 29500-1 §17.4: 115 twips leading and trailing). A
	// table style of an RTF document gives none (the style sheet's \\ts entries hold no row definitions).

	const leading = marginLeft ?? 115
	const trailing = marginRight ?? 115

	out.word("trgaph", leading).word("trpaddl", leading).word("trpaddr", trailing).word("trpaddfl", 3).word("trpaddfr", 3)
	if (autofit) out.word("trautofit", 1)

	let left = base ?? (indent ?? 0) - leading
	let after = 0
	let column = 0
	const grid = view.grid

	for (const property of view.trPr < 0 ? [] : children(document, view.trPr)) {
		const name = document.localName(property)

		switch (name) {
			case "cantSplit":
				if (on(document, property)) out.word("trkeep")
				break
			case "tblHeader":
				if (on(document, property)) out.word("trhdr")
				break
			case "trHeight": {
				const value = int(document, property, "w:val") ?? 0

				out.word("trrh", document.attribute(property, "w:hRule") === "exact" ? -value : value)
				break
			}
			case "gridBefore":
				column = int(document, property, "w:val") ?? 0

				for (let k = 0; k < column; k++) left += grid[k] ?? 0
				break
			case "gridAfter":
				after = int(document, property, "w:val") ?? 0
				break
			case "wBefore":
				preferredWidth(document, property, "trftsWidthB", "trwWidthB", out)
				break
			case "wAfter":
				preferredWidth(document, property, "trftsWidthA", "trwWidthA", out)
				break
			case "ins":
			case "del":
				// RTF 1.9.1 tracks a row only as \trauthN and \trdateN, "the author of changes to a table row's
				// properties" ("Table Row Revision Tracking"): an inserted or deleted row has no RTF.
				return refuse("rowRevision", `a tracked row ${name === "ins" ? "insertion" : "deletion"} (RTF 1.9.1 has no form for it)`)
			case "trPrChange":
				// The old properties (rowChange).
				break
			default:
				refuse("rowProperty", name)
		}
	}
	out.word("trleft", left)

	const sourceIndent = source?.indent

	if (sourceIndent !== undefined) {
		out.word("tblind", sourceIndent.relative ? left + sourceIndent.value : sourceIndent.value)
		if (sourceIndent.type >= 0) out.word("tblindtype", sourceIndent.type)
	}

	// Each cell: its definitions, then \cellx at its right edge (one per grid column it spans).
	let right = left
	const spans: number[] = []

	for (const tcPr of view.tcPrs) {
		let span = 1
		let cellWidth = 0
		const words = new RtfOut()
		// The preferred width: on the first of the cells a merged one is written as.
		const preferred = new RtfOut()

		{
			for (const property of tcPr < 0 ? [] : children(document, tcPr)) {
				const name = document.localName(property)

				switch (name) {
					case "tcW":
						cellWidth = width(document, property).w
						preferredWidth(document, property, "clftsWidth", "clwWidth", preferred)
						break
					case "gridSpan":
						span = Math.max(1, int(document, property, "w:val") ?? 1)
						break
					case "vMerge":
						words.word(document.attribute(property, "w:val") === "restart" ? "clvmgf" : "clvmrg")
						break
					case "tcBorders":
						for (const side of children(document, property)) {
							const local = document.localName(side)
							const word = CELL_BORDERS.get(local === "start" ? "left" : local === "end" ? "right" : local)

							if (word === undefined) refuse("border", local)

							words.word(word)
							border(document, side, context, words)
						}
						break
					case "shd":
						shading(document, property, context, words, {
							fill: "clcbpat",
							pattern: "clcfpat",
							percent: "clshdng",
							texture: "clbg"
						})
						break
					case "noWrap":
						words.word("clNoWrap")
						break
					case "tcMar":
						for (const side of children(document, property)) {
							const local = document.localName(side)
							const word = CELL_PADDING.get(local === "start" ? "left" : local === "end" ? "right" : local)

							if (word === undefined) refuse("cellProperty", `tcMar ${local}`)

							words.word(word, width(document, side).w)
						}
						break
					case "textDirection": {
						const value = document.attribute(property, "w:val")

						words.word(
							value === "tbRl" ? "cltxtbrl" : value === "btLr" ? "cltxbtlr" : refuse("cellProperty", `textDirection ${value}`)
						)
						break
					}
					case "vAlign": {
						const value = document.attribute(property, "w:val")

						words.word(
							value === "top"
								? "clvertalt"
								: value === "center"
									? "clvertalc"
									: value === "bottom"
										? "clvertalb"
										: refuse("cellProperty", `vAlign ${value}`)
						)
						break
					}
					case "cellIns":
					case "cellDel": {
						// Compared table cells (RTF 1.9.1, "Tables"): \clins / \cldel with author and date.
						const kind = name === "cellIns" ? "clins" : "cldel"
						const author = document.attribute(property, "w:author")
						const date = toDttm(document.attribute(property, "w:date"))

						words.word(kind)
						if (author !== undefined) words.word(`${kind}auth`, context.author(author))
						if (date !== 0) words.word(`${kind}dttm`, date)
						break
					}
					case "tcPrChange":
						// The old properties (rowChange).
						break
					default:
						refuse("cellProperty", name)
				}
			}
		}

		const columns = view.grid.slice(column, column + span)
		const edges: number[] = []

		if (columns.length === span && view.grid.length > 0) {
			let inner = true

			for (let edge = column + 1; edge < column + span && inner; edge++) inner = (divided?.[edge] ?? 0) > 0

			if (span > 1 && inner) edges.push(columns.reduce((sum, columnWidth) => sum + columnWidth, right))
			else for (const columnWidth of columns) edges.push((edges.at(-1) ?? right) + columnWidth)
		} else {
			edges.push(right + cellWidth)
		}

		const cell = joinChunks(words.finish())
		const cellWidthWords = joinChunks(preferred.finish())

		edges.forEach((edge, k) => {
			if (edges.length > 1) out.word(k === 0 ? "clmgf" : "clmrg")
			out.bytes(cell)
			if (k === 0) out.bytes(cellWidthWords)
			out.word("cellx", edge)
		})

		spans.push(edges.length)
		right = edges.at(-1) ?? right
		column += span
	}

	// Grid columns after the last cell: definitions without a cell, as the reader takes them (they only widen the grid).
	for (const columnWidth of view.grid.slice(column, column + after)) {
		right += columnWidth
		out.word("cellx", right)
	}

	return spans
}

// Per grid edge (0 the table's left, k after its kth column), how many of the row's table's rows have a cell edge
// there (a row's left, after w:gridBefore, and each cell's right). Counted once per table.
const DIVIDED = new WeakMap<XmlDocument, Map<number, Uint32Array>>()

function dividedEdges(document: XmlDocument, row: number, columns: number): Uint32Array | undefined {
	let table = document.parent(row)

	while (table >= 0 && document.localName(table) !== "tbl") table = document.parent(table)

	if (table < 0 || columns === 0) return undefined

	let tables = DIVIDED.get(document)

	if (tables === undefined) {
		tables = new Map()
		DIVIDED.set(document, tables)
	}

	const cached = tables.get(table)

	if (cached !== undefined) return cached

	const counts = new Uint32Array(columns + 1)
	const mark = (edge: number): void => {
		if (edge <= columns) counts[edge] = (counts[edge] ?? 0) + 1
	}
	// The table's rows, also those inside w:sdt or w:customXml; not those of tables nested in its cells.
	const stack = children(document, table)

	while (stack.length > 0) {
		const node = stack.pop() ?? -1
		const local = document.localName(node)

		if (local === "tr") {
			let column = 0

			for (const child of children(document, node)) {
				const name = document.localName(child)

				if (name === "trPr") {
					const before = children(document, child).find(property => document.localName(property) === "gridBefore")

					if (before !== undefined) column = int(document, before, "w:val") ?? 0
					mark(column)
				} else if (name === "tc") {
					const tcPr = children(document, child).find(property => document.localName(property) === "tcPr")
					const gridSpan =
						tcPr === undefined
							? undefined
							: children(document, tcPr).find(property => document.localName(property) === "gridSpan")

					column += gridSpan === undefined ? 1 : Math.max(1, int(document, gridSpan, "w:val") ?? 1)
					mark(column)
				}
			}
		} else if (local !== "tblPr" && local !== "tblGrid" && local !== "tc") {
			for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) stack.push(child)
		}
	}

	tables.set(table, counts)

	return counts
}

function gridOf(document: XmlDocument, tblPr: number): number[] {
	const table = tblPr < 0 ? -1 : document.parent(tblPr)
	const grid = table < 0 ? undefined : children(document, table).find(child => document.localName(child) === "tblGrid")

	return grid === undefined ? [] : children(document, grid).map(column => int(document, column, "w:w") ?? 0)
}

// ---- sections

const BREAK_WORDS = new Map([
	["nextPage", "sbkpage"],
	["continuous", "sbknone"],
	["nextColumn", "sbkcol"],
	["evenPage", "sbkeven"],
	["oddPage", "sbkodd"]
])

const PAGE_NUMBER_WORDS = new Map([
	["decimal", "pgndec"],
	["upperRoman", "pgnucrm"],
	["lowerRoman", "pgnlcrm"],
	["upperLetter", "pgnucltr"],
	["lowerLetter", "pgnlcltr"]
])

const LINE_RESTART_WORDS = new Map([
	["continuous", "linecont"],
	["newPage", "lineppage"],
	["newSection", "linerestart"]
])

const SECTION_ALIGN_WORDS = new Map([
	["top", "vertalt"],
	["center", "vertalc"],
	["both", "vertalj"],
	["bottom", "vertalb"]
])

export interface HeaderReference {
	readonly footer: boolean
	readonly type: string
	readonly id: string
}

// A w:sectPr as \sectd and the section's words (RTF 1.9.1, "Section Formatting Properties"); its header and footer
// references are the caller's (each a copy of the referenced story's group), returned.
export function sectionWords(document: XmlDocument, sectPr: number, context: EmitContext, out: RtfOut): HeaderReference[] {
	const references: HeaderReference[] = []

	out.word("sectd")

	for (const child of children(document, sectPr)) {
		const local = document.localName(child)

		switch (local) {
			case "sectPrChange":
				oldProps(document, child, "oldsprops", "sr", context, out, inner => {
					sectionWords(document, inner, context, out)
				})
				break
			case "headerReference":
			case "footerReference":
				references.push({
					footer: local === "footerReference",
					type: document.attribute(child, "w:type") ?? "default",
					id: document.attribute(child, "r:id") ?? ""
				})
				break
			case "type": {
				const word = BREAK_WORDS.get(document.attribute(child, "w:val") ?? "nextPage")

				if (word === undefined) refuse("section", `type ${document.attribute(child, "w:val")}`)

				out.word(word)
				break
			}
			case "pgSz":
				only(document, child, ["w:w", "w:h", "w:orient"])
				out.word("pgwsxn", int(document, child, "w:w") ?? 12240).word("pghsxn", int(document, child, "w:h") ?? 15840)
				if (document.attribute(child, "w:orient") === "landscape") out.word("lndscpsxn")
				break
			case "pgMar": {
				only(document, child, ["w:top", "w:right", "w:bottom", "w:left", "w:header", "w:footer", "w:gutter"])

				const words: readonly (readonly [string, string])[] = [
					["w:top", "margtsxn"],
					["w:right", "margrsxn"],
					["w:bottom", "margbsxn"],
					["w:left", "marglsxn"],
					["w:header", "headery"],
					["w:footer", "footery"],
					["w:gutter", "guttersxn"]
				]

				for (const [attribute, word] of words) {
					const value = int(document, child, attribute)

					if (value !== undefined) out.word(word, value)
				}
				break
			}
			case "lnNumType": {
				only(document, child, ["w:countBy", "w:distance", "w:start", "w:restart"])

				const countBy = int(document, child, "w:countBy") ?? 0
				const distance = int(document, child, "w:distance")
				const start = int(document, child, "w:start")
				const restart = LINE_RESTART_WORDS.get(document.attribute(child, "w:restart") ?? "newPage")

				if (restart === undefined) refuse("section", "lnNumType restart")
				if (countBy > 0) out.word("linemod", countBy)
				if (distance !== undefined) out.word("linex", distance)
				// \linestartsN is the first number; w:start counts from 0.
				if (start !== undefined) out.word("linestarts", start + 1)
				out.word(restart)
				break
			}
			case "pgNumType": {
				only(document, child, ["w:fmt", "w:start"])

				const format = document.attribute(child, "w:fmt")
				const start = int(document, child, "w:start")

				if (format !== undefined) out.word(PAGE_NUMBER_WORDS.get(format) ?? refuse("section", `page numbers ${format}`))
				if (start !== undefined) out.word("pgnstarts", start).word("pgnrestart")
				break
			}
			case "cols": {
				only(document, child, ["w:num", "w:space", "w:sep", "w:equalWidth"])

				const count = int(document, child, "w:num") ?? 1
				const space = int(document, child, "w:space")

				out.word("cols", count)
				if (space !== undefined) out.word("colsx", space)
				if (document.attribute(child, "w:sep") === "1" || document.attribute(child, "w:sep") === "true") out.word("linebetcol")

				children(document, child).forEach((column, k) => {
					only(document, column, ["w:w", "w:space"])
					out.word("colno", k + 1).word("colw", int(document, column, "w:w") ?? 0)

					const after = int(document, column, "w:space")

					if (after !== undefined) out.word("colsr", after)
				})
				break
			}
			case "vAlign":
				out.word(SECTION_ALIGN_WORDS.get(document.attribute(child, "w:val") ?? "") ?? refuse("section", "vAlign"))
				break
			case "titlePg":
				if (on(document, child)) out.word("titlepg")
				break
			case "bidi":
				if (on(document, child)) out.word("rtlsect")
				break
			default:
				refuse("section", local)
		}
	}

	return references
}
