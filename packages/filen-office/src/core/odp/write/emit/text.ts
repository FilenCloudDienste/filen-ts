import { OdfNs, readElement } from "../../../odf/index"
import { digestOf, sameDigest } from "../../../presentation/edit/changes"
import {
	refused,
	type Action,
	type Bullet,
	type Deck,
	type Paragraph,
	type ParaProps,
	type Refused,
	type Run,
	type RunProps,
	type SlideRef,
	type TextBody
} from "../../../presentation/model"
import { Namespaces, NodeKind, encodeUtf8, escapeAttribute, escapeText, parseXml } from "../../../xml/index"
import { NEAR_NUMBERINGS, NUMBERING_ALIASES, ODF_NUMBERINGS, embeddedListStyle, levelProps, paraPropsOf, runPropsOf } from "../../read/text"
import type { Fragment } from "../../read/context"
import { packagePart } from "../../read/fills"
import type { OdpEmitFamily } from "../emit"
import { odpParagraphKey } from "../../../anim/odf"
import { OdpStyles, cm, hexColor, paragraphAttributes, percent, runAttributes, setChild, setProperty, styleChanges } from "../styles"
import { isRefused } from "../../../presentation/refusal"
import { odpScaledTextChanges } from "./design"

// A shape's text as ODF paragraphs (ODF 1.3 Part 3 §5.1 text:p, §5.3 lists, §6 paragraph content), the inverse of the
// reader's mapping (read/text.ts):
//   - a paragraph's own properties and its end-of-paragraph run properties go into an automatic paragraph style (the
//     source paragraph's style patched, so what the model does not carry stays; the source's own when it reads back
//     the same), each run's properties beyond the paragraph's into a span style;
//   - whitespace is written so that §6.1.2 collapsing reads it back exactly (text:s, text:tab);
//   - levels and bullets become text:list nesting under a list style made from the paragraphs' bullets (§16.30–§16.34),
//     each level checked by the reader's own level mapping; an outline object's paragraphs whose bullets the model
//     leaves to inheritance stay in an unstyled list;
//   - hyperlinks are text:a; fields are the ODF fields the reader reads.

// The text family: a shape's body as paragraph markup (the shape family places it in its element).
export const emitOdpText: OdpEmitFamily = {
	emit(request, context) {
		const body = request.shape?.text

		if (body === undefined) return { kind: "markup", pieces: [] }
		if (!(context.styles instanceof OdpStyles)) return refused("failed", "the save's styles")

		const deck = context.deck
		const slide = request.slide
		const shape = request.shape
		// The ids a by-paragraph effect names paragraphs without one by (the save's, OdpEmitContext.paragraphIds).
		let given: Map<Paragraph, string> | undefined

		if (context.paragraphIds !== undefined && shape !== undefined)
			body.paragraphs.forEach((paragraph, index) => {
				const id = context.paragraphIds?.get(odpParagraphKey(shape.id, index))

				if (id !== undefined) (given ??= new Map()).set(paragraph, id)
			})

		const scope: TextWriteScope = {
			deck,
			styles: context.styles,
			fragment: context.document === undefined ? undefined : context.styles.env.fragmentOf(context.document),
			outline: request.shape?.ph?.type === "body" && slide.kind !== "notes",
			ids: new Set(),
			...(given === undefined ? {} : { given }),
			jump: target => {
				const at = deck.slides.indexOf(slide.ref)

				return at < 0 ? undefined : deck.slides[jumpIndex(target, at, deck.slides.length) ?? -1]
			}
		}
		const markup = textMarkup(scope, body)

		return isRefused(markup) ? markup : { kind: "markup", pieces: [markup] }
	}
}

export interface TextWriteScope {
	// The deck written (its text scale after a scaled slide size change).
	readonly deck: Deck
	readonly styles: OdpStyles
	// The source fragment the shape's paragraphs came from, when the shape has a source.
	readonly fragment: Fragment | undefined
	// An outline object: paragraphs whose bullets the model leaves to inheritance stay in an unstyled list.
	readonly outline: boolean
	// The slide a relative jump of the shape's slide lands on now (ODF links name pages, not "next").
	jump?(target: "next" | "previous" | "first" | "last"): SlideRef | undefined
	// Paragraph IDs written so far (each is written once).
	readonly ids: Set<string>
	// The xml:id a paragraph without one of its source is given (a by-paragraph effect's target).
	readonly given?: ReadonlyMap<Paragraph, string>
}

// Where a relative jump from slide `at` of `count` lands, or undefined past either end.
export function jumpIndex(
	target: "next" | "previous" | "first" | "last" | "end" | "lastViewed",
	at: number,
	count: number
): number | undefined {
	const index = target === "next" ? at + 1 : target === "previous" ? at - 1 : target === "first" ? 0 : target === "last" ? count - 1 : -1

	return index >= 0 && index < count ? index : undefined
}

const SPACE = 0x20
const TAB = 0x09

// Characters XML 1.0 cannot hold (§2.2), and line breaks inside a run (a break is a br run).
const UNWRITABLE = {
	test(text: string): boolean {
		for (let k = 0; k < text.length; k++) {
			const code = text.charCodeAt(k)

			if ((code < 0x20 && code !== TAB) || code === 0xfffe || code === 0xffff) return true
		}

		return false
	}
}

interface Cursor {
	// The reader's state: the last character written was a collapsible space (or the paragraph has just begun).
	space: boolean
	out: string
}

// A run's characters, with the spaces the reader would collapse or drop written as text:s.
function writeChars(cursor: Cursor, text: string, last: boolean): Refused | undefined {
	if (UNWRITABLE.test(text)) return refused("unsupported", "a character text cannot hold")

	let pending = 0
	let plain = ""
	const flushPlain = (): void => {
		if (plain !== "") cursor.out += escapeText(plain)
		plain = ""
	}
	const flushSpaces = (): void => {
		if (pending === 0) return

		flushPlain()
		cursor.out += pending === 1 ? "<text:s/>" : `<text:s text:c="${String(pending)}"/>`
		pending = 0
		cursor.space = false
	}

	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code === SPACE) {
			if (cursor.space || pending > 0 || (last && k === text.length - 1)) {
				pending++
			} else {
				plain += " "
				cursor.space = true
			}

			continue
		}

		flushSpaces()

		if (code === TAB) {
			flushPlain()
			cursor.out += "<text:tab/>"
			cursor.space = false

			continue
		}

		plain += text[k]
		cursor.space = false
	}

	flushSpaces()
	flushPlain()

	return undefined
}

const FIELD_ELEMENTS: Readonly<Record<string, string>> = {
	slidenum: "text:page-number",
	"odf:page-count": "text:page-count",
	datetime10: "text:time"
}

function fieldElement(type: string): string | undefined {
	if (FIELD_ELEMENTS[type] !== undefined) return FIELD_ELEMENTS[type]
	if (/^datetime\d*$/u.test(type)) return "text:date"
	if (/^odf:[a-z-]+$/u.test(type)) return `text:${type.slice(4)}`

	return undefined
}

function hrefOf(action: Action, scope: TextWriteScope): string | Refused {
	switch (action.kind) {
		case "url":
			return action.href
		case "refused":
			return action.raw
		case "slide": {
			const name = scope.styles.env.pageName(action.slide)

			return name === undefined ? refused("notFound", "the slide a link jumps to") : `#${name.replace(/%/gu, "%25")}`
		}
		case "internal": {
			// A text link names a page: a relative jump is written to the page it lands on now. One that lands past the
			// deck's ends (a "next slide" on the last) ends the show where it is clicked, as a link to no page reads in
			// ODF (LibreOffice and the reader take it as no link): written as text alone.
			if (action.jump === "end" || action.jump === "lastViewed") return refused("unsupported", `a text link to ${action.jump}`)

			const ref = scope.jump?.(action.jump)
			const name = ref === undefined ? undefined : scope.styles.env.pageName(ref)

			return name === undefined ? "" : `#${name.replace(/%/gu, "%25")}`
		}
		default:
			return refused("unsupported", `a text link of kind ${action.kind}`)
	}
}

function same(a: unknown, b: unknown): boolean {
	return sameDigest(a, b)
}

// What a span adds over the paragraph's run properties (the reader merges a span's own properties over them).
function ownRun(rPr: RunProps, base: RunProps): RunProps {
	const out: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(rPr)) {
		if (key === "hlinkClick" || value === undefined) continue
		if (!same(value, (base as Record<string, unknown>)[key])) out[key] = value
	}

	return out as RunProps
}

// Text properties the model maps (read/text.ts runPropsOf): a patched paragraph style has them all set from the model.
const MODEL_TEXT_ATTRIBUTES = [
	"fo:font-size",
	"fo:font-weight",
	"style:font-weight-asian",
	"style:font-weight-complex",
	"fo:font-style",
	"style:font-style-asian",
	"style:font-style-complex",
	"style:text-underline-style",
	"style:text-underline-width",
	"style:text-underline-color",
	"style:text-underline-type",
	"style:text-underline-mode",
	"style:text-line-through-style",
	"style:text-line-through-type",
	"style:text-position",
	"fo:text-transform",
	"fo:font-variant",
	"fo:letter-spacing",
	"fo:language",
	"fo:country",
	"style:font-name",
	"fo:font-family",
	"style:font-name-asian",
	"style:font-family-asian",
	"style:font-name-complex",
	"style:font-family-complex",
	"fo:color",
	"style:use-window-font-color",
	"fo:background-color"
]

// Paragraph properties the model maps (read/text.ts paraPropsOf).
const MODEL_PARAGRAPH_ATTRIBUTES = [
	"fo:text-align",
	"fo:margin-left",
	"fo:margin-right",
	"fo:text-indent",
	"fo:line-height",
	"style:line-height-at-least",
	"fo:margin-top",
	"fo:margin-bottom",
	"style:writing-mode",
	"style:tab-stop-distance",
	"style:font-independent-line-spacing"
]

// A span style for what a run adds (spans carry only that).
function spanStyle(scope: TextWriteScope, own: RunProps): string | Refused | undefined {
	if (Object.keys(own).length === 0) return undefined

	const attributes = runAttributes(own)

	if (isRefused(attributes)) return attributes

	const changes = styleChanges()

	for (const [name, value] of attributes) setProperty(changes, "text", name, value)

	return scope.styles.derived("text", undefined, changes)
}

// The paragraph's automatic style: the source paragraph's own style (when it has one) with every property the model
// maps set from the target; the source's own name when it reads back the same.
function paragraphStyle(
	scope: TextWriteScope,
	source: string | undefined,
	pPr: ParaProps,
	marL: number | undefined,
	withIndent: boolean,
	base: RunProps,
	// The source style's own margin and first-line indent kept as they are (a labelled list paragraph: its level
	// places the line, and LibreOffice starts the label at the indents the paragraph had).
	sourceIndents = false
): string | Refused | undefined {
	const { indent: _indent, ...noIndent } = pPr
	const own = paragraphAttributes(withIndent ? pPr : noIndent, marL)

	if (isRefused(own)) return own

	const text = runAttributes(base)

	if (isRefused(text)) return text

	if (source !== undefined) {
		const style = scope.styles.env.context.ownStyle("paragraph", source, scope.styles.scope)
		const { marL: _marL, indent: _readIndent, ...unindented } = paraPropsOf(style.paragraph)
		const read = sourceIndents ? unindented : paraPropsOf(style.paragraph)
		const want = paraPropsOf({ attributes: own.attributes, children: [] })

		if (
			own.tabs === undefined &&
			read.tabs === undefined &&
			same(read, want) &&
			same(runPropsOf(scope.styles.env.context, style.text), base)
		)
			return source
	}

	if (own.attributes.size === 0 && text.size === 0 && own.tabs === undefined && source === undefined) return undefined

	const changes = styleChanges()

	for (const name of MODEL_PARAGRAPH_ATTRIBUTES)
		if (!sourceIndents || (name !== "fo:margin-left" && name !== "fo:text-indent")) setProperty(changes, "paragraph", name, null)
	for (const name of MODEL_TEXT_ATTRIBUTES) setProperty(changes, "text", name, null)
	for (const [name, value] of own.attributes) setProperty(changes, "paragraph", name, value)
	for (const [name, value] of text) setProperty(changes, "text", name, value)

	setChild(changes, "paragraph", "style:tab-stops", own.tabs ?? null)

	return scope.styles.derived("paragraph", source, changes)
}

// The source element of a paragraph read from the shape's own fragment (-1 when it has none there).
function sourceNode(scope: TextWriteScope, paragraph: Paragraph): number {
	const src = paragraph.src
	const fragment = scope.fragment

	if (src?.format !== "odp" || fragment === undefined || src.fragment !== fragment.offset || src.epoch !== fragment.epoch) return -1
	if (src.node <= 0 || src.node >= fragment.document.count) return -1

	return src.node
}

function sourceStyleOf(scope: TextWriteScope, paragraph: Paragraph): string | undefined {
	const node = sourceNode(scope, paragraph)

	return node < 0 ? undefined : scope.fragment?.attributes(node).get("text:style-name")
}

// The span styles of a paragraph's source element, for runs written again that read the same as one of them (the
// span style then keeps what the model does not carry, such as a font's pitch).
function sourceSpanStyles(scope: TextWriteScope, paragraph: Paragraph): string[] {
	const node = sourceNode(scope, paragraph)
	const fragment = scope.fragment

	if (node < 0 || fragment === undefined) return []

	const out: string[] = []
	const document = fragment.document
	const stack = [node]

	for (let at = stack.pop(); at !== undefined && out.length < MAX_SOURCE_SPANS; at = stack.pop()) {
		for (let child = document.firstChildElement(at); child >= 0; child = document.nextSiblingElement(child)) {
			if (fragment.name(child) !== "text:span") continue

			const name = fragment.attributes(child).get("text:style-name")

			if (name !== undefined && !out.includes(name)) out.push(name)

			stack.push(child)
		}
	}

	return out
}

// Span styles of a source paragraph looked at for reuse.
const MAX_SOURCE_SPANS = 16

// A source span style a run's own properties read back as, when one does.
function reusedSpanStyle(scope: TextWriteScope, candidates: readonly string[], own: RunProps, base: RunProps): string | undefined {
	const context = scope.styles.env.context

	for (const name of candidates) {
		const read = runPropsOf(context, context.ownStyle("text", name, scope.styles.scope).text)

		if (same(ownRun({ ...base, ...read }, base), own)) return name
	}

	return undefined
}

function writeRuns(scope: TextWriteScope, paragraph: Paragraph, base: RunProps): string | Refused {
	const cursor: Cursor = { space: true, out: "" }
	const runs = paragraph.runs
	const spans = sourceSpanStyles(scope, paragraph)
	let lastText = -1

	for (let k = runs.length - 1; k >= 0 && lastText < 0; k--) if (runs[k]?.kind !== "br") lastText = k

	for (let index = 0; index < runs.length; index++) {
		const run = runs[index] as Run

		if (run.kind === "opaque") return refused("unsupported", "run content kept as its source")

		const own = ownRun(run.rPr, base)
		const style = (Object.keys(own).length === 0 ? undefined : reusedSpanStyle(scope, spans, own, base)) ?? spanStyle(scope, own)

		if (isRefused(style)) return style

		let open = ""
		let close = ""
		const link = run.rPr.hlinkClick

		// The span outside the link (as LibreOffice writes it: its import takes a link's text whole, not its spans).
		if (style !== undefined) {
			open += `<text:span text:style-name="${escapeAttribute(style)}">`
			close = "</text:span>"
		}

		if (link !== undefined) {
			const href = hrefOf(link, scope)

			if (isRefused(href)) return href

			if (href !== "") {
				open += `<text:a xlink:type="simple" xlink:href="${escapeAttribute(href)}">`
				close = `</text:a>${close}`
			}
		}

		cursor.out += open

		switch (run.kind) {
			case "r": {
				const failed = writeChars(cursor, run.text, index === lastText)

				if (failed !== undefined) return failed
				break
			}
			case "br":
				cursor.out += "<text:line-break/>"
				cursor.space = false
				break
			case "fld": {
				const element = fieldElement(run.type)

				if (element === undefined) return refused("unsupported", `field ${run.type}`)
				if (UNWRITABLE.test(run.text)) return refused("unsupported", "a character text cannot hold")

				cursor.out += `<${element}>${escapeText(run.text)}</${element}>`
				cursor.space = false
				break
			}
		}

		cursor.out += close
	}

	return cursor.out
}

// The paragraph's base run properties: its end-of-paragraph ones when every run has each of them (the reader reads
// each run as the paragraph's properties with its span's over them: a span can change a property, never take one
// away), else none.
function baseRunProps(paragraph: Paragraph): RunProps {
	const end = paragraph.endRPr ?? {}
	const keys = Object.keys(end).filter(key => key !== "hlinkClick")
	const covers = (rPr: RunProps): boolean => keys.every(key => (rPr as Record<string, unknown>)[key] !== undefined)

	return paragraph.runs.every(run => run.kind === "opaque" || covers(run.rPr)) ? end : {}
}

// --- Lists. ---

// ST_TextAutonumberScheme values ODF numbering reads back as (read/text.ts ODF_NUMBERINGS): format, prefix, suffix.
// A scheme held only as another is refused here (the conversion writes it as that one, emit through fresh.ts).
const SCHEMES = new Map([...ODF_NUMBERINGS].filter(([scheme]) => !NEAR_NUMBERINGS.has(scheme) && !NUMBERING_ALIASES.has(scheme)))

// A picture label's size (fo:width, fo:height): LibreOffice draws a picture level without one as nothing.
interface PictureSize {
	readonly width: string
	readonly height: string
}

interface LevelBullet {
	readonly image?: PictureSize
	readonly bullet: Bullet
	readonly buClr: ParaProps["buClr"]
	readonly buSz: ParaProps["buSz"]
	readonly buFont: ParaProps["buFont"]
	readonly marL: number
	readonly indent: number
}

function levelOf(pPr: ParaProps, image?: PictureSize): LevelBullet {
	return {
		...(image === undefined ? {} : { image }),
		bullet: pPr.bullet ?? { kind: "none" },
		buClr: pPr.buClr,
		buSz: pPr.buSz,
		buFont: pPr.buFont,
		marL: pPr.marL ?? 0,
		indent: pPr.indent ?? 0
	}
}

// One list level element (§16.31–§16.33) giving `level`'s bullet and indents.
function levelMarkup(depth: number, level: LevelBullet): string | Refused {
	const text: string[] = []

	if (level.bullet.kind !== "none" && level.buClr !== undefined && level.buClr !== "text") {
		const color = hexColor(level.buClr)

		if (isRefused(color)) return color

		text.push(`fo:color="${color}"`)
	}

	if (level.bullet.kind === "char" && level.buFont !== undefined && level.buFont !== "text")
		text.push(`fo:font-family="${escapeAttribute(level.buFont.typeface)}"`)

	// The label's size as its text properties' fo:font-size (§20.183), a percentage of the text's: LibreOffice Impress
	// reads a label's size there only (it ignores text:bullet-relative-size, and draws a bullet or number without one
	// tiny), so a label the size of its text is written 100%.
	if (level.bullet.kind !== "none" && level.buSz !== undefined && level.buSz !== "text") {
		if (!("pct" in level.buSz)) return refused("unsupported", "a bullet size in points")

		text.push(`fo:font-size="${percent(level.buSz.pct / 1000)}"`)
	} else if (level.bullet.kind === "char" || level.bullet.kind === "autoNum") text.push('fo:font-size="100%"')

	// A hanging or flush first line is placed by text:space-before and text:min-label-width (§19.880
	// label-width-and-position, the mode LibreOffice Impress lays lists out in): the label starts at marL + indent and
	// the text at marL. A first line indented past the text has no such form: label alignment (§19.840) holds it.
	// A picture centred on its line (as LibreOffice writes one) at its size.
	const picture =
		level.bullet.kind === "blip" && level.image !== undefined
			? ` style:vertical-pos="middle" style:vertical-rel="line" fo:width="${escapeAttribute(level.image.width)}" fo:height="${escapeAttribute(level.image.height)}"`
			: ""
	const properties =
		level.indent <= 0
			? `<style:list-level-properties text:space-before="${cm(level.marL + level.indent)}" text:min-label-width="${cm(0 - level.indent)}"${picture}/>`
			: `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"${picture}>` +
				`<style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="${cm(level.marL)}" fo:text-indent="${cm(level.indent)}"/>` +
				"</style:list-level-properties>"
	const textProperties = text.length === 0 ? "" : `<style:text-properties ${text.join(" ")}/>`
	const at = ` text:level="${String(depth)}"`

	switch (level.bullet.kind) {
		case "none":
			// No label: a number style without a format (§19.500 style:num-format "": no number).
			return `<text:list-level-style-number${at} style:num-format="">${properties}</text:list-level-style-number>`
		case "char":
			// One character (§19.778): the reader takes the first.
			return `<text:list-level-style-bullet${at} text:bullet-char="${escapeAttribute([...level.bullet.char][0] ?? "")}">${properties}${textProperties}</text:list-level-style-bullet>`
		case "autoNum": {
			const scheme = SCHEMES.get(level.bullet.scheme)

			if (scheme === undefined) return refused("unsupported", `numbering ${level.bullet.scheme}`)

			const [format, prefix, suffix] = scheme

			return (
				`<text:list-level-style-number${at} style:num-format="${format}"${prefix === "" ? "" : ` style:num-prefix="${prefix}"`}` +
				`${suffix === "" ? "" : ` style:num-suffix="${suffix}"`}>${properties}${textProperties}</text:list-level-style-number>`
			)
		}
		case "blip":
			// A picture the package holds (§16.33 text:list-level-style-image).
			return `<text:list-level-style-image${at} xlink:href="${escapeAttribute(level.bullet.part.replace(/^\//u, ""))}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad">${properties}${textProperties}</text:list-level-style-image>`
	}
}

const PARSE_SCOPE = `xmlns:text="${OdfNs.text}" xmlns:style="${OdfNs.style}" xmlns:fo="${OdfNs.fo}" xmlns:xlink="${OdfNs.xlink}"`

// What a level element gives a paragraph, by the reader's own mapping (a generated level is checked, not trusted).
function readsAs(scope: TextWriteScope, markup: string, depth: number, start: number | undefined): Partial<ParaProps> | undefined {
	const document = parseXml(encodeUtf8(`<text:list-style ${PARSE_SCOPE}>${markup}</text:list-style>`))
	const parsed = embeddedListStyle(readElement(document, new Namespaces(document), document.documentElement()))

	return parsed === undefined ? undefined : levelProps(scope.styles.env.context, parsed.levels.get(depth), start)
}

// A bullet the size of its text: 100% of it is the text's own size (read/text.ts reads 100% as "text").
export function bulletSize(size: ParaProps["buSz"]): ParaProps["buSz"] {
	return size !== undefined && size !== "text" && "pct" in size && size.pct === 100_000 ? "text" : size
}

// A list paragraph's label fields compared with what its level gives (its indents are its own, written with it).
function matches(pPr: ParaProps, read: Partial<ParaProps>, bulleted: boolean): boolean {
	if (!bulleted) return pPr.bullet === undefined || pPr.bullet.kind === "none"

	// A number's font is the text's (ODF reads a font for bullet characters only).
	const keys = pPr.bullet?.kind === "char" ? (["bullet", "buClr", "buSz", "buFont"] as const) : (["bullet", "buClr", "buSz"] as const)

	for (const key of keys) {
		const value = pPr[key]

		if (value !== undefined && !same(key === "buSz" ? bulletSize(value as ParaProps["buSz"]) : value, read[key])) return false
	}

	return true
}

interface Entry {
	readonly paragraph: Paragraph
	// 1-based list depth, 0 outside lists.
	readonly depth: number
	// The paragraph starts a list item (its bullet shows); false: a list header (no bullet).
	readonly item: boolean
}

function entriesOf(scope: TextWriteScope, body: TextBody): Entry[] {
	return body.paragraphs.map(paragraph => {
		const pPr = paragraph.pPr
		const lvl = pPr.lvl ?? 0
		const bulleted = pPr.bullet !== undefined && pPr.bullet.kind !== "none"

		if (pPr.bullet === undefined && scope.outline) return { paragraph, depth: lvl + 1, item: true }
		if (!bulleted && lvl === 0) return { paragraph, depth: 0, item: false }

		return { paragraph, depth: lvl + 1, item: bulleted }
	})
}

// A body's paragraphs as markup: paragraphs outside lists, and runs of list paragraphs as text:list nesting.
export function textMarkup(scope: TextWriteScope, body: TextBody): string | Refused {
	const entries = entriesOf(scope, body)
	let out = ""
	let index = 0

	while (index < entries.length) {
		const entry = entries[index] as Entry

		if (entry.depth === 0) {
			const header = headerMarkup(scope, entries, index)

			if (isRefused(header)) return header

			if (header !== undefined) {
				out += header.markup
				index = header.next

				continue
			}

			const markup = paragraphMarkup(scope, entry.paragraph, entry.paragraph.pPr.marL, true)

			if (isRefused(markup)) return markup

			out += markup
			index++

			continue
		}

		const list = listMarkup(scope, entries, index)

		if (isRefused(list)) return list

		out += list.markup
		index = list.next
	}

	return out
}

// The source list header (§5.3.3 text:list-header) of a top-level text:list a paragraph without a bullet was read
// from: the list element, its header and its style. A paragraph written again from it stays in it, so the list's
// style (and what the model does not carry of it) still applies.
function sourceHeader(
	scope: TextWriteScope,
	paragraph: Paragraph
): { readonly list: number; readonly header: number; readonly style: string } | undefined {
	const node = sourceNode(scope, paragraph)
	const fragment = scope.fragment

	if (node < 0 || fragment === undefined) return undefined

	const document = fragment.document
	const header = document.parent(node)
	const list = header < 0 ? -1 : document.parent(header)
	const container = list < 0 ? -1 : document.parent(list)

	if (header < 0 || list < 0 || container < 0) return undefined
	if (fragment.name(header) !== "text:list-header" || fragment.name(list) !== "text:list") return undefined
	if (fragment.name(container) === "text:list-item" || fragment.name(container) === "text:list-header") return undefined

	const style = fragment.attributes(list).get("text:style-name")

	return style === undefined ? undefined : { list, header, style }
}

// Paragraphs without a bullet read from one source list header, written back in a list header under the source
// list's style, when that list's first level reads them as they are (their margin over the level's own); undefined
// when the paragraph at `from` was not read from one, or its list reads it otherwise (then it is written plain).
function headerMarkup(
	scope: TextWriteScope,
	entries: readonly Entry[],
	from: number
): { readonly markup: string; readonly next: number } | Refused | undefined {
	const first = entries[from]
	const header = first === undefined ? undefined : sourceHeader(scope, first.paragraph)

	if (header === undefined) return undefined

	const context = scope.styles.env.context
	const level = context.sheet.listStyle(header.style, scope.styles.scope)?.levels.get(1)

	if (level === undefined) return undefined

	const read = levelProps(context, level, undefined)
	let out = ""
	let next = from

	for (; next < entries.length; next++) {
		const entry = entries[next] as Entry

		if (entry.depth !== 0 || sourceHeader(scope, entry.paragraph)?.header !== header.header) break

		const pPr = entry.paragraph.pPr

		if (!matches(pPr, read, false)) break

		const markup = paragraphMarkup(scope, entry.paragraph, pPr.marL, true)

		if (isRefused(markup)) return markup

		out += markup
	}

	if (next === from) return undefined

	return {
		markup: `<text:list text:style-name="${escapeAttribute(header.style)}"><text:list-header>${out}</text:list-header></text:list>`,
		next
	}
}

// The IDs a source paragraph carries (§19.914 xml:id, text:id): animations and links name the paragraph by them, so
// the paragraph written in its place keeps them (the first written from it, when an edit split it).
function idsOf(scope: TextWriteScope, paragraph: Paragraph): string {
	const own = sourceIds(scope, paragraph)
	const given = scope.given?.get(paragraph)

	if (given === undefined || own.includes(" xml:id=") || scope.ids.has(given)) return own

	scope.ids.add(given)

	return `${own} xml:id="${escapeAttribute(given)}"`
}

function sourceIds(scope: TextWriteScope, paragraph: Paragraph): string {
	const src = paragraph.src
	const fragment = scope.fragment

	if (src?.format !== "odp" || fragment === undefined || src.fragment !== fragment.offset || src.epoch !== fragment.epoch) return ""
	if (src.node <= 0 || src.node >= fragment.document.count) return ""

	const attributes = fragment.attributes(src.node)
	let out = ""

	for (const name of ["xml:id", "text:id"] as const) {
		const value = attributes.get(name)

		if (value === undefined || scope.ids.has(value)) continue

		scope.ids.add(value)
		out += ` ${name}="${escapeAttribute(value)}"`
	}

	return out
}

function paragraphMarkup(
	scope: TextWriteScope,
	paragraph: Paragraph,
	marL: number | undefined,
	withIndent: boolean,
	sourceIndents = false
): string | Refused {
	const base = baseRunProps(paragraph)
	const style = paragraphStyle(scope, sourceStyleOf(scope, paragraph), paragraph.pPr, marL, withIndent, base, sourceIndents)

	if (isRefused(style)) return style

	const written = writeRuns(scope, paragraph, base)

	if (isRefused(written)) return written

	const end = sourceEndSpan(scope, paragraph)
	const runs = end === undefined ? written : `${written}<text:span text:style-name="${escapeAttribute(end)}"/>`
	const head = `<text:p${style === undefined ? "" : ` text:style-name="${escapeAttribute(style)}"`}${idsOf(scope, paragraph)}`

	return runs === "" ? `${head}/>` : `${head}>${runs}</text:p>`
}

// The style of the empty text:span its source paragraph ends with (Microsoft's export writes one per paragraph):
// written again (its sizes scaled with the text), as LibreOffice sizes an empty paragraph's line by it; the reader
// takes no properties from it.
function sourceEndSpan(scope: TextWriteScope, paragraph: Paragraph): string | undefined {
	const node = sourceNode(scope, paragraph)
	const fragment = scope.fragment

	if (node < 0 || fragment === undefined) return undefined

	const document = fragment.document
	let last = -1

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) last = child

	if (last < 0 || document.kind(last) !== NodeKind.Element || fragment.name(last) !== "text:span" || document.firstChild(last) >= 0)
		return undefined

	const name = fragment.attributes(last).get("text:style-name")

	if (name === undefined) return undefined

	// Its sizes at the content's text scale (a scaled slide size change), as the paragraph's own runs are.
	const changes = styleChanges()

	odpScaledTextChanges(changes, scope.deck, scope.styles.style("text", name))

	return changes.attributes.size === 0 ? name : scope.styles.derived("text", name, changes)
}

// The level each depth of a run of list paragraphs gets: the first item's bullet and indents at that depth (a depth
// only list headers use: their margin, no bullet).
function runLevels(scope: TextWriteScope, entries: readonly Entry[], from: number, end: number): Map<number, LevelBullet> {
	const levels = new Map<number, LevelBullet>()

	for (let index = from; index < end; index++) {
		const entry = entries[index] as Entry

		if (entry.item && !levels.has(entry.depth))
			levels.set(entry.depth, levelOf(entry.paragraph.pPr, pictureSize(scope, entry.paragraph, entry.depth)))
	}

	for (let index = from; index < end; index++) {
		const entry = entries[index] as Entry

		if (!levels.has(entry.depth)) levels.set(entry.depth, { ...levelOf(entry.paragraph.pPr), bullet: { kind: "none" }, indent: 0 })
	}

	return levels
}

// A picture label's size: its source level's (the same picture at the same depth of the list the paragraph was read
// from), else its text's size (a picture the size of its text, as the model draws one).
function pictureSize(scope: TextWriteScope, paragraph: Paragraph, depth: number): PictureSize | undefined {
	const bullet = paragraph.pPr.bullet

	if (bullet?.kind !== "blip") return undefined

	const node = sourceNode(scope, paragraph)
	const fragment = scope.fragment

	if (node >= 0 && fragment !== undefined) {
		let list = -1

		for (let at = fragment.document.parent(node); at > 0; at = fragment.document.parent(at))
			if (fragment.name(at) === "text:list" && fragment.attributes(at).has("text:style-name")) list = at

		const name = list < 0 ? undefined : fragment.attributes(list).get("text:style-name")
		const level = name === undefined ? undefined : scope.styles.env.context.sheet.listStyle(name, fragment.scope)?.levels.get(depth)
		const attributes = level?.properties.attributes
		const width = attributes?.get("fo:width")
		const height = attributes?.get("fo:height")

		if (
			level?.kind === "image" &&
			packagePart(level.attributes.get("xlink:href")) === bullet.part &&
			width !== undefined &&
			height !== undefined
		)
			return { width, height }
	}

	const first = paragraph.runs.find(run => run.kind !== "opaque")
	const points = ((first !== undefined && "rPr" in first ? first.rPr.sz : undefined) ?? paragraph.endRPr?.sz ?? 1800) / 100
	const size = `${String(Number(points.toFixed(2)))}pt`

	return { width: size, height: size }
}

// The end of a run of list paragraphs one list style can give: consecutive list entries with their bullets either
// all inherited or all given, each depth's items agreeing on bullet and indent.
function runEnd(entries: readonly Entry[], from: number, inherited: boolean): number {
	const seen = new Map<number, string>()
	let end = from

	for (; end < entries.length; end++) {
		const entry = entries[end] as Entry

		if (entry.depth === 0 || (entry.paragraph.pPr.bullet === undefined) !== inherited) break
		if (inherited || !entry.item) continue

		const key = digestOf({ ...levelOf(entry.paragraph.pPr), marL: 0 })
		const held = seen.get(entry.depth)

		if (held === undefined) seen.set(entry.depth, key)
		else if (held !== key) break
	}

	return Math.max(end, from + 1)
}

// One run of list paragraphs as one text:list, under a generated list style unless every bullet is inherited.
function listMarkup(
	scope: TextWriteScope,
	entries: readonly Entry[],
	from: number
): { readonly markup: string; readonly next: number } | Refused {
	const inherited = entries[from]?.paragraph.pPr.bullet === undefined
	const end = runEnd(entries, from, inherited)
	const levels = inherited ? new Map<number, LevelBullet>() : runLevels(scope, entries, from, end)
	const elements = new Map<number, string>()
	let style: string | undefined

	if (!inherited) {
		let markup = ""

		for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
			const element = levelMarkup(depth, levels.get(depth) as LevelBullet)

			if (isRefused(element)) return element

			elements.set(depth, element)
			markup += element
		}

		style = scope.styles.list(markup)
	}

	// Each open list: whether an item is open (a paragraph without a bullet continues it) and whether it has a child yet
	// (a list header comes first, §5.3.3).
	const stack: { itemOpen: boolean; children: boolean }[] = []
	let out = ""
	const closeTop = (): void => {
		const top = stack[stack.length - 1]

		if (top?.itemOpen === true) {
			out += "</text:list-item>"
			top.itemOpen = false
		}
	}

	for (let index = from; index < end; index++) {
		const entry = entries[index] as Entry
		const pPr = entry.paragraph.pPr

		while (stack.length > entry.depth) {
			closeTop()
			out += "</text:list>"
			stack.pop()
		}

		const current = stack[stack.length - 1]
		// A paragraph without a bullet continues the open item at its depth; with none open, it heads a list of its own.
		const continues = !entry.item && stack.length === entry.depth && current?.itemOpen === true

		if (stack.length === entry.depth && !continues) closeTop()

		if (!entry.item && !continues && stack.length === entry.depth && current?.children === true) {
			out += "</text:list>"
			stack.pop()
		}

		while (stack.length < entry.depth) {
			const top = stack[stack.length - 1]

			if (top !== undefined && !top.itemOpen) {
				out += "<text:list-item>"
				top.itemOpen = true
			}

			if (top !== undefined) top.children = true

			out += stack.length === 0 && style !== undefined ? `<text:list text:style-name="${escapeAttribute(style)}">` : "<text:list>"
			stack.push({ itemOpen: false, children: false })
		}

		const startAt = pPr.bullet?.kind === "autoNum" ? pPr.bullet.startAt : undefined
		// A labelled paragraph's level places its line (read/text.ts): the paragraph keeps the margin and first-line indent
		// its source style had and writes none of its own, so LibreOffice places its label as the source did (it starts
		// the label at the paragraph's margin and indent plus the level's space-before). A list header has no label, and a label-aligned level gives way to the paragraph's own
		// margins in LibreOffice: their own margins place them.
		if (!inherited) {
			const read = readsAs(scope, elements.get(entry.depth) ?? "", entry.depth, startAt)

			if (read === undefined || !matches(pPr, read, entry.item)) return refused("unsupported", "a bullet its list level cannot give")
		}

		const paragraph =
			inherited || !entry.item || (levels.get(entry.depth)?.indent ?? 0) > 0
				? paragraphMarkup(scope, entry.paragraph, pPr.marL, true)
				: paragraphMarkup(scope, entry.paragraph, undefined, false, true)

		if (isRefused(paragraph)) return paragraph

		const top = stack[stack.length - 1]

		if (entry.item) {
			out += `<text:list-item${startAt === undefined ? "" : ` text:start-value="${String(startAt)}"`}>${paragraph}`

			if (top !== undefined) {
				top.itemOpen = true
				top.children = true
			}
		} else if (continues) {
			out += paragraph
		} else {
			out += `<text:list-header>${paragraph}</text:list-header>`

			if (top !== undefined) top.children = true
		}
	}

	while (stack.length > 0) {
		closeTop()
		out += "</text:list>"
		stack.pop()
	}

	return { markup: out, next: end }
}
