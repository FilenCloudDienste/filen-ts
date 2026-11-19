import { OdfNs, elementName } from "../../odf/index"
import { NodeKind, type Namespaces, type XmlDocument } from "../../xml/index"
import { FIELDS_AS_TEXT, PASS_THROUGH_INLINE } from "../translator"

// A source paragraph's characters, each with the text:span style it was written in, so a rewrite of the paragraph
// can give each character that is still there its span style back: what that style says beyond what its
// WordprocessingML translation holds (an overline, East Asian bold, a custom raise...) is then kept rather than lost.
// Characters are counted as the paragraph's WordprocessingML reads (wmlText): text as written, one for a tab, a line
// break, a picture, a note, a comment and a field.

export interface SourceText {
	readonly text: string
	// Per UTF-16 unit of `text`: the span style giving it (undefined: none), null where spans nest or a link styles it.
	readonly styles: readonly (string | null | undefined)[]
	// The edited paragraph is a new one (a split's half): its runs were written anew, naming no source span.
	readonly fresh?: boolean
}

// A unit standing for an object (a picture, a note, a comment, a field's result).
const OBJECT = "￼"

// Fields the translator keeps as w:fldSimple results (copied whole when their code and result stay).
export const KEPT_FIELDS: ReadonlySet<string> = new Set([
	"text:reference-ref",
	"text:bookmark-ref",
	"text:sequence-ref",
	"text:note-ref",
	"text:bibliography-mark",
	...FIELDS_AS_TEXT,
	...[...PASS_THROUGH_INLINE].filter(name => name !== "text:meta" && name !== "text:ruby-base")
])
const FIELD_ATOMS: ReadonlySet<string> = new Set(["text:page-number", "text:page-count", ...KEPT_FIELDS])
const NOTHING: ReadonlySet<string> = new Set([
	"text:soft-page-break",
	"text:bookmark",
	"text:bookmark-start",
	"text:bookmark-end",
	"text:reference-mark",
	"text:reference-mark-start",
	"text:reference-mark-end",
	"text:change",
	"text:change-start",
	"text:change-end",
	"office:annotation-end",
	"text:ruby-text",
	"text:alphabetical-index-mark-start",
	"text:alphabetical-index-mark-end",
	"text:toc-mark",
	"text:toc-mark-start",
	"text:toc-mark-end",
	"text:user-index-mark",
	"text:user-index-mark-start",
	"text:user-index-mark-end",
	"field:fieldmark-start",
	"field:fieldmark-end",
	"text:hidden-paragraph",
	"draw:glue-point"
])

// A text: attribute's value (`local` in the text namespace, whatever prefix binds it).
function textAttribute(document: XmlDocument, namespaces: Namespaces, node: number, local: string): string | undefined {
	for (const attribute of document.attributes(node)) {
		const colon = attribute.name.indexOf(":")

		if (colon < 0 || attribute.name.slice(colon + 1) !== local) continue
		if (namespaces.uri(node, attribute.name.slice(0, colon)) === OdfNs.text) return attribute.value
	}

	return undefined
}

// The characters of an ODF paragraph (text:p, text:h) as the translator writes them (Part 3 §6.1.2 whitespace), with
// their span styles; undefined where it holds what this does not count as the translator does.
export function odfText(document: XmlDocument, namespaces: Namespaces, paragraph: number): SourceText | undefined {
	let text = ""
	const styles: (string | null | undefined)[] = []
	let trimLeading = true
	let known = true
	const add = (value: string, style: string | null | undefined): void => {
		text += value

		for (let k = 0; k < value.length; k++) styles.push(style)
	}
	const walk = (node: number, style: string | null | undefined, counted: boolean): void => {
		for (let child = document.firstChild(node); child >= 0 && known; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Text || kind === NodeKind.CData) {
				let value = document.text(child).replace(/[\t\n\r ]+/gu, " ")

				if (trimLeading) value = value.replace(/^ /u, "")
				if (value === "") continue

				trimLeading = value.endsWith(" ")

				if (counted) add(value, style)

				continue
			}

			if (kind !== NodeKind.Element) continue

			const name = elementName(document, namespaces, child)

			switch (name) {
				case "text:span": {
					const own = textAttribute(document, namespaces, child, "style-name")

					walk(child, own === undefined ? style : style === undefined ? own : null, counted)
					break
				}
				case "text:a": {
					const own = textAttribute(document, namespaces, child, "style-name")

					walk(child, own === undefined ? style : null, counted)
					break
				}
				case "text:s": {
					const count = Math.max(1, Math.min(10_000, Number(textAttribute(document, namespaces, child, "c") ?? "1") || 1))

					if (counted) add(" ".repeat(count), style)

					trimLeading = false
					break
				}
				case "text:tab":
					if (counted) add("\t", style)

					trimLeading = false
					break
				case "text:line-break":
					if (counted) add("\n", style)

					trimLeading = false
					break
				case "text:note":
					if (counted) add(OBJECT, style)

					trimLeading = false
					break
				case "office:annotation":
					if (counted) add(OBJECT, style)

					break
				case "text:hidden-text":
					if (textAttribute(document, namespaces, child, "is-hidden") !== "true") walk(child, style, counted)

					break
				case "text:ruby":
				case "text:meta":
				case "text:ruby-base":
					walk(child, style, counted)
					break
				default:
					if (NOTHING.has(name)) break

					if (name.startsWith("draw:") || name.startsWith("dr3d:")) {
						if (counted) add(OBJECT, style)
						if (textAttribute(document, namespaces, child, "anchor-type") === "as-char") trimLeading = false

						break
					}

					if (FIELD_ATOMS.has(name)) {
						// A field's result: one unit; its text still moves the whitespace state.
						if (counted) add(OBJECT, style)

						if (name === "text:page-number" || name === "text:page-count") trimLeading = false
						else walk(child, style, false)

						break
					}

					known = false
			}
		}
	}

	walk(paragraph, undefined, true)

	return known ? { text, styles } : undefined
}

// The characters of a WordprocessingML paragraph as the ODT writer walks it (OdfEmitter.content and run).
export function wmlText(document: XmlDocument, paragraph: number): string {
	let out = ""
	const content = (node: number): void => {
		for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
			switch (document.localName(at)) {
				case "r":
					run(at)
					break
				case "hyperlink":
				case "ins":
					content(at)
					break
				case "fldSimple":
				case "commentRangeStart":
					out += OBJECT
					break
				default:
					break
			}
		}
	}
	const run = (node: number): void => {
		for (let at = document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
			switch (document.localName(at)) {
				case "t":
				case "delText":
					out += document.textContent(at)
					break
				case "tab":
					out += "\t"
					break
				case "br":
				case "cr":
					out += "\n"
					break
				case "softHyphen":
					out += "­"
					break
				case "noBreakHyphen":
					out += "‑"
					break
				case "drawing":
				case "footnoteReference":
				case "endnoteReference":
					out += OBJECT
					break
				default:
					break
			}
		}
	}

	content(paragraph)

	return out
}

// The source span style of each character of an edited paragraph (`edited`, as wmlText reads it): the characters it
// shares with the source's start and end are those characters (aligned); one between takes its nearest aligned
// neighbour's style, kept only where its properties are that style's.
export interface TextMapping {
	readonly styles: readonly (string | null | undefined)[]
	readonly aligned: Uint8Array
	// The edited paragraph's runs still name the source spans they came from (w:rsidR): a run naming none is none's.
	readonly origins?: boolean
}

export function mapText(source: SourceText, edited: string): TextMapping {
	const text = source.text
	const length = edited.length
	let head = 0

	while (head < length && head < text.length && edited.charCodeAt(head) === text.charCodeAt(head)) head++

	let tail = 0

	while (
		tail < length - head &&
		tail < text.length - head &&
		edited.charCodeAt(length - 1 - tail) === text.charCodeAt(text.length - 1 - tail)
	)
		tail++

	const styles: (string | null | undefined)[] = new Array<string | null | undefined>(length)
	const aligned = new Uint8Array(length)

	for (let k = 0; k < head; k++) {
		styles[k] = source.styles[k]
		aligned[k] = 1
	}

	for (let k = length - tail; k < length; k++) {
		styles[k] = source.styles[text.length - (length - k)]
		aligned[k] = 1
	}

	const between = head > 0 ? styles[head - 1] : tail > 0 ? styles[length - tail] : null

	for (let k = head; k < length - tail; k++) styles[k] = between

	return { styles, aligned, origins: source.fresh !== true }
}

// The source paragraph's text when its translation (`translated`, wmlText) reads the same, so characters count alike.
export function sourceTextOf(
	document: XmlDocument,
	namespaces: Namespaces,
	paragraph: number,
	tDoc: XmlDocument,
	translated: number
): SourceText | undefined {
	const read = odfText(document, namespaces, paragraph)

	if (read === undefined || !read.styles.some(style => style !== undefined)) return undefined

	return read.text === wmlText(tDoc, translated) ? read : undefined
}
