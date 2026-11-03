import type { PropertyValue } from "./meaning"

// WordprocessingML run and paragraph properties as the ODF attributes the translator reads them from (props.ts, in
// reverse): each property element on its own, so a style can be patched where only some changed. A property with no
// ODF form returns undefined (the writer then refuses the block). `neutral` gives what turns a property off where a
// style below would otherwise show through.

const UNDERLINES: Readonly<
	Record<string, readonly [style: string, type?: string | undefined, width?: string | undefined, mode?: string | undefined]>
> = {
	single: ["solid"],
	words: ["solid", undefined, undefined, "skip-white-space"],
	double: ["solid", "double"],
	thick: ["solid", undefined, "bold"],
	dotted: ["dotted"],
	dottedHeavy: ["dotted", undefined, "bold"],
	dash: ["dash"],
	dashedHeavy: ["dash", undefined, "bold"],
	dashLong: ["long-dash"],
	dashLongHeavy: ["long-dash", undefined, "bold"],
	dotDash: ["dot-dash"],
	dashDotHeavy: ["dot-dash", undefined, "bold"],
	dotDotDash: ["dot-dot-dash"],
	dashDotDotHeavy: ["dot-dot-dash", undefined, "bold"],
	wave: ["wave"],
	wavyHeavy: ["wave", undefined, "bold"],
	wavyDouble: ["wave", "double"]
}

const BORDER_STYLES: Readonly<Record<string, string>> = {
	single: "solid",
	double: "double",
	dotted: "dotted",
	dashed: "dashed",
	threeDEngrave: "groove",
	threeDEmboss: "ridge",
	inset: "inset",
	outset: "outset",
	dotDash: "dash-dot",
	dotDotDash: "dash-dot-dot"
}

function on(value: PropertyValue): boolean {
	return value.attributes.get("val") !== "off"
}

function hex(value: string | undefined): string | undefined {
	return value !== undefined && /^[0-9a-fA-F]{6}$/u.test(value) ? `#${value.toLowerCase()}` : undefined
}

function points(twips: string | undefined): string | undefined {
	const value = Number(twips)

	return twips === undefined || !Number.isFinite(value) ? undefined : `${round(value / 20)}pt`
}

function round(value: number): string {
	return String(Math.round(value * 10_000) / 10_000)
}

// A face the document declares (style:font-face) for a family, else the family itself.
export interface FontFaces {
	face(family: string): string
}

// The ODF attributes of one run property (rPr child). `fontSize`: the size in effect, in points (for w:position).
export function runAttributes(local: string, value: PropertyValue, fonts: FontFaces, fontSize: number): [string, string][] | undefined {
	const attributes = value.attributes
	const val = attributes.get("val")

	switch (local) {
		case "rStyle":
			return []
		case "rFonts": {
			const out: [string, string][] = []
			const ascii = attributes.get("ascii") ?? attributes.get("hAnsi")

			if (ascii !== undefined) out.push(["style:font-name", fonts.face(ascii)])
			if (attributes.get("eastAsia") !== undefined) out.push(["style:font-name-asian", fonts.face(attributes.get("eastAsia") ?? "")])
			if (attributes.get("cs") !== undefined) out.push(["style:font-name-complex", fonts.face(attributes.get("cs") ?? "")])

			return out
		}
		// w:b, w:i and w:sz apply to East Asian text too (ECMA-376 Part 1 §17.3.2.1, §17.3.2.16, §17.3.2.38).
		case "b":
			return [
				["fo:font-weight", on(value) ? "bold" : "normal"],
				["style:font-weight-asian", on(value) ? "bold" : "normal"]
			]
		case "bCs":
			return [["style:font-weight-complex", on(value) ? "bold" : "normal"]]
		case "i":
			return [
				["fo:font-style", on(value) ? "italic" : "normal"],
				["style:font-style-asian", on(value) ? "italic" : "normal"]
			]
		case "iCs":
			return [["style:font-style-complex", on(value) ? "italic" : "normal"]]
		case "caps":
			return [["fo:text-transform", on(value) ? "uppercase" : "none"]]
		case "smallCaps":
			return [["fo:font-variant", on(value) ? "small-caps" : "normal"]]
		case "strike":
			return [["style:text-line-through-style", on(value) ? "solid" : "none"]]
		case "dstrike":
			return on(value)
				? [
						["style:text-line-through-style", "solid"],
						["style:text-line-through-type", "double"]
					]
				: [["style:text-line-through-style", "none"]]
		case "outline":
			return [["style:text-outline", on(value) ? "true" : "false"]]
		case "shadow":
			return [["fo:text-shadow", on(value) ? "1pt 1pt" : "none"]]
		case "emboss":
			return on(value) ? [["style:font-relief", "embossed"]] : [["style:font-relief", "none"]]
		case "imprint":
			return on(value) ? [["style:font-relief", "engraved"]] : [["style:font-relief", "none"]]
		case "vanish":
			return on(value) ? [["text:display", "none"]] : [["text:display", "true"]]
		case "color":
			if (val === "auto") return [["style:use-window-font-color", "true"]]

			return hex(val) === undefined ? undefined : [["fo:color", hex(val) ?? ""]]
		case "spacing": {
			const twips = Number(val)

			if (!Number.isFinite(twips)) return undefined

			return [["fo:letter-spacing", twips === 0 ? "normal" : `${round(twips / 20)}pt`]]
		}
		case "w":
			return val === undefined ? undefined : [["style:text-scale", `${val}%`]]
		case "position": {
			const halfPoints = Number(val)

			if (!Number.isFinite(halfPoints) || fontSize <= 0) return undefined

			return [["style:text-position", halfPoints === 0 ? "0% 100%" : `${round((halfPoints * 50) / fontSize)}% 100%`]]
		}
		case "vertAlign":
			return val === "superscript"
				? [["style:text-position", "super 58%"]]
				: val === "subscript"
					? [["style:text-position", "sub 58%"]]
					: [["style:text-position", "0% 100%"]]
		case "sz":
			return Number.isFinite(Number(val))
				? [
						["fo:font-size", `${round(Number(val) / 2)}pt`],
						["style:font-size-asian", `${round(Number(val) / 2)}pt`]
					]
				: undefined
		case "szCs":
			return Number.isFinite(Number(val)) ? [["style:font-size-complex", `${round(Number(val) / 2)}pt`]] : undefined
		case "u": {
			if (val === "none") return [["style:text-underline-style", "none"]]

			const form = UNDERLINES[val ?? "single"]

			if (form === undefined) return undefined

			const [style, type, width, mode] = form
			const out: [string, string][] = [["style:text-underline-style", style]]

			if (type !== undefined) out.push(["style:text-underline-type", type])
			if (width !== undefined) out.push(["style:text-underline-width", width])
			if (mode !== undefined) out.push(["style:text-underline-mode", mode])

			const color = hex(attributes.get("color"))

			out.push(["style:text-underline-color", color ?? "font-color"])

			return out
		}
		case "shd": {
			if (attributes.get("val") !== "clear" && attributes.get("val") !== "nil") return undefined

			const fill = attributes.get("fill")

			return [["fo:background-color", fill === undefined || fill === "auto" ? "transparent" : (hex(fill) ?? "transparent")]]
		}
		case "em":
			return [["style:text-emphasize", val === "circle" ? "circle above" : val === "none" ? "none" : "dot above"]]
		case "lang": {
			const out: [string, string][] = []
			const add = (tag: string | undefined, language: string, country: string): void => {
				if (tag === undefined) return

				const [lang = "", region] = tag.split("-")

				out.push([language, lang])
				out.push([country, region ?? "none"])
			}

			add(attributes.get("val"), "fo:language", "fo:country")
			add(attributes.get("eastAsia"), "style:language-asian", "style:country-asian")
			add(attributes.get("bidi"), "style:language-complex", "style:country-complex")

			return out
		}
		case "noProof":
		case "webHidden":
		case "snapToGrid":
			// Proofing, web view and grid snapping have no ODF form and nothing shows of them on a page.
			return on(value) ? undefined : []
		default:
			return undefined
	}
}

// What turns a run property off: the attributes whose run property says what an absent one does.
export function neutralRun(
	local: string,
	fonts: FontFaces,
	inherited: PropertyValue | undefined,
	fontSize: number
): [string, string][] | undefined {
	switch (local) {
		case "b":
		case "bCs":
		case "i":
		case "iCs":
		case "caps":
		case "smallCaps":
		case "strike":
		case "dstrike":
		case "outline":
		case "shadow":
		case "emboss":
		case "imprint":
		case "vanish":
			return runAttributes(local, { attributes: new Map([["val", "off"]]), children: "" }, fonts, fontSize)
		case "color":
			return [["style:use-window-font-color", "true"]]
		case "u":
			return [["style:text-underline-style", "none"]]
		case "position":
		case "vertAlign":
			return [["style:text-position", "0% 100%"]]
		case "shd":
			return [["fo:background-color", "transparent"]]
		case "spacing":
			return [["fo:letter-spacing", "normal"]]
		case "w":
			return [["style:text-scale", "100%"]]
		case "em":
			return [["style:text-emphasize", "none"]]
		default:
			// A value only a style below defines (a face, a size, a language): that style's own.
			return inherited === undefined ? undefined : runAttributes(local, inherited, fonts, fontSize)
	}
}

function border(value: PropertyValue | undefined): { border: string; padding: string | undefined } | undefined {
	if (value === undefined) return undefined

	const kind = value.attributes.get("val") ?? "single"

	if (kind === "nil") return { border: "none", padding: undefined }

	// The translation's padding beside no line (a border that draws nothing, with its spacing).
	if (kind === "none") {
		const space = value.attributes.get("space")

		return { border: "none", padding: space === undefined || space === "0" ? undefined : `${space}pt` }
	}

	const style = BORDER_STYLES[kind]
	const size = Number(value.attributes.get("sz") ?? "4")

	if (style === undefined || !Number.isFinite(size)) return undefined

	const color = value.attributes.get("color")
	const space = value.attributes.get("space")

	return {
		border: `${round(size / 8)}pt ${style} ${color === undefined || color === "auto" ? "#000000" : (hex(color) ?? "#000000")}`,
		padding: space === undefined ? undefined : `${space}pt`
	}
}

// Borders of a paragraph or cell (pBdr, tcBorders children): fo:border-* (and fo:padding-* for a paragraph's).
export function borderAttributes(children: string, withPadding: boolean): [string, string][] | undefined {
	const out: [string, string][] = []

	for (const side of ["top", "left", "bottom", "right"] as const) {
		const match = new RegExp(
			`<(?:${side}|${side === "left" ? "start" : side === "right" ? "end" : side})((?: [a-zA-Z:]+="[^"]*")*)>`,
			"u"
		).exec(children)

		if (match === null) continue

		const attributes = new Map<string, string>()

		for (const pair of (match[1] ?? "").matchAll(/ ([a-zA-Z:]+)="([^"]*)"/gu))
			attributes.set(pair[1] ?? "", JSON.parse(`"${pair[2] ?? ""}"`) as string)

		const found = border({ attributes, children: "" })

		if (found === undefined) return undefined
		if (found.border.includes("double")) return undefined

		out.push([`fo:border-${side}`, found.border])

		if (withPadding && found.padding !== undefined) out.push([`fo:padding-${side}`, found.padding])
	}

	return out
}

// What one paragraph property is in ODF: style:paragraph-properties attributes, tab stops as `tabs` markup, and the
// paragraph style's style:text-properties attributes it is (`text`).
export interface ParagraphAttributes {
	readonly attributes: [string, string][]
	readonly tabs?: string
	readonly text?: [string, string][]
}

// The ODF attributes of one paragraph property (pPr child).
export function paragraphAttributes(
	local: string,
	value: PropertyValue,
	context: { readonly tabsRelativeToIndent: boolean; readonly marginLeft: number }
): ParagraphAttributes | undefined {
	const attributes = value.attributes
	const val = attributes.get("val")

	switch (local) {
		case "pStyle":
		case "numPr":
		case "outlineLvl":
		case "rPr":
		case "sectPr":
			return { attributes: [] }
		case "keepNext":
			return { attributes: [["fo:keep-with-next", on(value) ? "always" : "auto"]] }
		case "keepLines":
			return { attributes: [["fo:keep-together", on(value) ? "always" : "auto"]] }
		case "pageBreakBefore":
			return { attributes: [["fo:break-before", on(value) ? "page" : "auto"]] }
		case "widowControl":
			return {
				attributes: [
					["fo:widows", on(value) ? "2" : "0"],
					["fo:orphans", on(value) ? "2" : "0"]
				]
			}
		case "pBdr": {
			const borders = borderAttributes(value.children, true)

			return borders === undefined ? undefined : { attributes: borders }
		}
		case "shd": {
			if (attributes.get("val") !== "clear" && attributes.get("val") !== "nil") return undefined

			const fill = attributes.get("fill")

			return {
				attributes: [["fo:background-color", fill === undefined || fill === "auto" ? "transparent" : (hex(fill) ?? "transparent")]]
			}
		}
		case "tabs": {
			let tabs = ""

			for (const stop of value.children.matchAll(/<tab((?: [a-zA-Z:]+="[^"]*")*)>/gu)) {
				const tab = new Map<string, string>()

				for (const pair of (stop[1] ?? "").matchAll(/ ([a-zA-Z:]+)="([^"]*)"/gu)) tab.set(pair[1] ?? "", pair[2] ?? "")

				const kind = tab.get("val") ?? "left"

				if (kind === "clear") continue
				if (kind === "bar" || kind === "num") return undefined

				const type =
					kind === "center" ? "center" : kind === "right" || kind === "end" ? "right" : kind === "decimal" ? "char" : "left"
				const at = Number(tab.get("pos") ?? "0") / 20 - (context.tabsRelativeToIndent ? context.marginLeft : 0)
				const leader = tab.get("leader")
				const leaderText =
					leader === "dot"
						? "."
						: leader === "hyphen"
							? "-"
							: leader === "underscore"
								? "_"
								: leader === "middleDot"
									? "·"
									: undefined

				tabs += `<style:tab-stop style:position="${round(at)}pt"${type === "left" ? "" : ` style:type="${type}"`}${type === "char" ? ' style:char="."' : ""}${leaderText === undefined ? "" : ` style:leader-style="solid" style:leader-text="${leaderText}"`}/>`
			}

			return { attributes: [], tabs }
		}
		case "suppressAutoHyphens":
			// A text property in ODF (fo:hyphenate on style:text-properties): the paragraph style's.
			return { attributes: [], text: [["fo:hyphenate", on(value) ? "false" : "true"]] }
		case "bidi":
			return { attributes: [["style:writing-mode", on(value) ? "rl-tb" : "lr-tb"]] }
		case "spacing": {
			const out: [string, string][] = []
			const before = points(attributes.get("before"))
			const after = points(attributes.get("after"))

			if (
				attributes.has("beforeAutospacing") ||
				attributes.has("afterAutospacing") ||
				attributes.has("beforeLines") ||
				attributes.has("afterLines")
			) {
				return undefined
			}

			if (before !== undefined) out.push(["fo:margin-top", before])
			if (after !== undefined) out.push(["fo:margin-bottom", after])

			const line = attributes.get("line")
			const rule = attributes.get("lineRule") ?? "auto"

			if (line !== undefined) {
				if (rule === "auto") out.push(["fo:line-height", `${round(Number(line) / 2.4)}%`])
				else if (rule === "exact") out.push(["fo:line-height", points(line) ?? "0pt"])
				else out.push(["style:line-height-at-least", points(line) ?? "0pt"])
			}

			return { attributes: out }
		}
		case "ind": {
			const left = Number(attributes.get("left") ?? "0") / 20
			const right = Number(attributes.get("right") ?? "0") / 20
			const first = Number(attributes.get("firstLine") ?? "0") / 20

			if (
				attributes.has("leftChars") ||
				attributes.has("rightChars") ||
				attributes.has("firstLineChars") ||
				attributes.has("hangingChars")
			) {
				return undefined
			}

			return {
				attributes: [
					["fo:margin-left", `${round(left)}pt`],
					["fo:margin-right", `${round(right)}pt`],
					["fo:text-indent", `${round(first)}pt`]
				]
			}
		}
		case "contextualSpacing":
			return { attributes: [["style:contextual-spacing", on(value) ? "true" : "false"]] }
		case "jc": {
			// Left and right as they are (a right-to-left paragraph's start is its right, Part 3 §20.223 fo:text-align):
			// the translation reads them back the same whatever the direction.
			const align =
				val === "center"
					? "center"
					: val === "both" || val === "distribute"
						? "justify"
						: val === "right" || val === "left" || val === "end"
							? val
							: "start"

			if (val === "distribute") return undefined

			return { attributes: [["fo:text-align", align]] }
		}
		case "textAlignment":
			return {
				attributes: [
					[
						"style:vertical-align",
						val === "center"
							? "middle"
							: val === "bottom"
								? "bottom"
								: val === "top"
									? "top"
									: val === "baseline"
										? "baseline"
										: "auto"
					]
				]
			}
		case "snapToGrid":
		case "suppressLineNumbers":
		case "adjustRightInd":
		case "autoSpaceDE":
		case "autoSpaceDN":
		case "kinsoku":
		case "wordWrap":
		case "overflowPunct":
		case "topLinePunct":
			return on(value) ? undefined : { attributes: [] }
		default:
			return undefined
	}
}

// The paragraph style's text properties a paragraph property element is read from.
export function paragraphTextSources(local: string): readonly string[] {
	return local === "suppressAutoHyphens" ? ["fo:hyphenate"] : []
}

// The ODF attributes a paragraph property element is read from (removing it removes them).
export function paragraphSources(local: string): readonly string[] {
	switch (local) {
		case "keepNext":
			return ["fo:keep-with-next"]
		case "keepLines":
			return ["fo:keep-together"]
		case "pageBreakBefore":
			return ["fo:break-before"]
		case "widowControl":
			return ["fo:widows", "fo:orphans"]
		case "pBdr":
			return SIDES.flatMap(side => [`fo:border-${side}`, `fo:padding-${side}`, `style:border-line-width-${side}`])
		case "shd":
			return ["fo:background-color"]
		case "suppressAutoHyphens":
			// Where earlier saves put it (no ODF attribute there); its own place is paragraphTextSources'.
			return ["fo:hyphenate"]
		case "bidi":
			return ["style:writing-mode"]
		case "spacing":
			return ["fo:margin-top", "fo:margin-bottom", "fo:line-height", "style:line-height-at-least", "style:line-spacing"]
		case "ind":
			return ["fo:margin-left", "fo:margin-right", "fo:text-indent"]
		case "contextualSpacing":
			return ["style:contextual-spacing", "loext:contextual-spacing"]
		case "jc":
			return ["fo:text-align"]
		case "textAlignment":
			return ["style:vertical-align"]
		default:
			return []
	}
}

const SIDES = ["top", "left", "bottom", "right"] as const

// The ODF attributes a run property element is read from.
export function runSources(local: string): readonly string[] {
	switch (local) {
		case "rFonts":
			return [
				"style:font-name",
				"fo:font-family",
				"style:font-family-generic",
				"style:font-pitch",
				"style:font-charset",
				"style:font-name-asian",
				"style:font-family-asian",
				"style:font-family-generic-asian",
				"style:font-pitch-asian",
				"style:font-name-complex",
				"style:font-family-complex",
				"style:font-family-generic-complex",
				"style:font-pitch-complex"
			]
		case "b":
			return ["fo:font-weight", "style:font-weight-asian"]
		case "bCs":
			return ["style:font-weight-complex"]
		case "i":
			return ["fo:font-style", "style:font-style-asian"]
		case "iCs":
			return ["style:font-style-complex"]
		case "caps":
			return ["fo:text-transform"]
		case "smallCaps":
			return ["fo:font-variant"]
		case "strike":
		case "dstrike":
			return [
				"style:text-line-through-style",
				"style:text-line-through-type",
				"style:text-line-through-width",
				"style:text-line-through-color",
				"style:text-line-through-mode"
			]
		case "outline":
			return ["style:text-outline"]
		case "shadow":
			return ["fo:text-shadow"]
		case "emboss":
		case "imprint":
			return ["style:font-relief"]
		case "vanish":
			return ["text:display"]
		case "color":
			return ["fo:color", "style:use-window-font-color"]
		case "spacing":
			return ["fo:letter-spacing"]
		case "w":
			return ["style:text-scale"]
		case "position":
		case "vertAlign":
			return ["style:text-position"]
		case "sz":
			return ["fo:font-size", "style:font-size-asian"]
		case "szCs":
			return ["style:font-size-complex"]
		case "u":
			return [
				"style:text-underline-style",
				"style:text-underline-type",
				"style:text-underline-width",
				"style:text-underline-color",
				"style:text-underline-mode"
			]
		case "shd":
			return ["fo:background-color"]
		case "em":
			return ["style:text-emphasize"]
		case "lang":
			return [
				"fo:language",
				"fo:country",
				"fo:script",
				"style:language-asian",
				"style:country-asian",
				"style:language-complex",
				"style:country-complex",
				"style:rfc-language-tag"
			]
		default:
			return []
	}
}
