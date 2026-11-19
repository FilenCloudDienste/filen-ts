// Portions derived from SuperDoc 1.46.3 (packages/layout-engine/painters/dom/src/features/math: the per-object
// converters for n-ary operators, delimiters, function names, accents, phantoms and border boxes), copyright
// Harbour and the SuperDoc contributors, licensed under the GNU Affero General Public License v3.0, and from
// docx-preview (docxjs, src/html-renderer.ts renderMml*), copyright Volodymyr Baydalka, licensed under the
// Apache License 2.0. Modified for @filen/office.

// Office Math (ECMA-376 Part 1 §22.1) to a MathML Core element tree. Elements are matched by namespace URI
// (transitional and Strict), never by prefix. Nothing here throws on odd input: unknown elements are
// descended into so their text survives, and malformed attributes read as absent.

import { MC_NAMESPACE, Namespaces, NodeKind, selectAlternateContent, type XmlDocument } from "../xml/index"
import { MathStyle, mathStyle, styleText } from "./alphabets"
import { TokenKind, tokenize } from "./tokens"
import { MathFrame, type MathAlign, type MathAttributes, type MathColumnAlign, type MathElement, type MathNode } from "./tree"

const MATH_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/math",
	"http://purl.oclc.org/ooxml/officeDocument/math"
])

const WORD_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	"http://purl.oclc.org/ooxml/wordprocessingml/main"
])

export type LimitLocation = "undOvr" | "subSup"

export interface OmmlOptions {
	// Where limits of integrals and other n-ary operators go when m:limLoc is absent: the document's
	// m:mathPr m:intLim and m:naryLim (defaults subSup and undOvr).
	readonly integralLimits?: LimitLocation
	readonly naryLimits?: LimitLocation
	// The part's namespace map, when the caller already has one (building it scans the whole part).
	readonly namespaces?: Namespaces
	// How tracked changes inside the equation show (w:ins / w:del around its runs and objects, and in an object's
	// m:ctrlPr): without, as the final document has it. In the markup view each change is marked with its author
	// (an index; MathAttributes.revision).
	readonly revisions?: OmmlRevisionView
}

export interface OmmlRevisionView {
	readonly view: "final" | "original" | "markup"
	readonly author?: (name: string | undefined) => number
}

// MathAttributes.revision: an insertion (1) or deletion (2) with its author's colour slot (1..8, 0 for none)
// above them, as layout's revisionLook packs text.
export const MathRevision = { INSERTED: 1, DELETED: 2 } as const

const AUTHOR_SLOTS = 8

function revisionAttribute(deleted: boolean, author: number): number {
	const slot = author < 0 ? AUTHOR_SLOTS : (author % AUTHOR_SLOTS) + 1

	return (deleted ? MathRevision.DELETED : MathRevision.INSERTED) | (slot << 2)
}

// Nesting beyond this is dropped: each level adds a few output levels, and the tree must stay well inside
// MAX_MATH_DEPTH for renderers that recurse over it.
const MAX_NESTING = 96

const Group = { OTHER: 0, MATH: 1, WORD: 2, MC: 3 } as const

type Group = (typeof Group)[keyof typeof Group]

// Row markers: an alignment point (& in m:t, m:aln) and a line break (w:br, m:brk). Only rows that lay
// out lines or columns keep them; every other slot drops them.
const ALIGN = { marker: "align" } as const
const BREAK = { marker: "break" } as const

type Item = MathElement | typeof ALIGN | typeof BREAK

const Flag = {
	// Inside m:fName (or a script/limit base under it): letters group into upright names.
	NAME: 1,
	// The row keeps ALIGN markers.
	ALIGN: 2,
	// The row keeps BREAK markers.
	BREAK: 4
} as const

const INTEGRAL_FIRST = 0x222b
const INTEGRAL_LAST = 0x2233

// Accent characters written as combining marks, by the spacing form a MathML mover draws.
const SPACING_ACCENTS: ReadonlyMap<string, string> = new Map([
	["\u0300", "`"],
	["\u0301", "´"],
	["\u0302", "^"],
	["\u0303", "~"],
	["\u0304", "¯"],
	["\u0305", "¯"],
	["\u0306", "˘"],
	["\u0307", "˙"],
	["\u0308", "¨"],
	["\u030a", "˚"],
	["\u030b", "˝"],
	["\u030c", "ˇ"],
	["\u20d6", "←"],
	["\u20d7", "→"],
	["\u20e1", "↔"]
])

const namespaceCache = new WeakMap<XmlDocument, Namespaces>()

function namespacesOf(document: XmlDocument, given: Namespaces | undefined): Namespaces {
	if (given !== undefined && given.document === document) return given

	let namespaces = namespaceCache.get(document)

	if (namespaces === undefined) {
		namespaces = new Namespaces(document, { lenient: true })
		namespaceCache.set(document, namespaces)
	}

	return namespaces
}

function element(tag: MathElement["tag"], children: readonly MathNode[], attributes?: MathAttributes): MathElement {
	return attributes === undefined ? { tag, children } : { tag, attributes, children }
}

function elementsOf(items: readonly Item[]): MathElement[] {
	const out: MathElement[] = []

	for (const item of items) {
		if (item !== ALIGN && item !== BREAK) out.push(item as MathElement)
	}

	return out
}

// One element for a sequence: the element itself when there is exactly one, else an mrow.
function row(children: readonly MathElement[]): MathElement {
	return children.length === 1 && children[0] !== undefined ? children[0] : element("mrow", children)
}

// The children of a row element, for schemata with an inferred mrow (msqrt, mtd, mphantom...).
function unwrap(node: MathElement): readonly MathElement[] {
	return node.tag === "mrow" && node.attributes === undefined ? (node.children as readonly MathElement[]) : [node]
}

function operator(text: string, attributes?: MathAttributes): MathElement {
	return element("mo", [text], attributes)
}

// Turns leading and trailing U+0020 runs into no-break spaces, leaving inner spaces alone.
function keepEdgeSpaces(text: string): string {
	let lead = 0

	while (lead < text.length && text.charCodeAt(lead) === 0x20) lead++

	if (lead === text.length) return "\u00a0".repeat(lead)

	let trail = 0

	while (text.charCodeAt(text.length - 1 - trail) === 0x20) trail++

	if (lead === 0 && trail === 0) return text

	return "\u00a0".repeat(lead) + text.slice(lead, text.length - trail) + "\u00a0".repeat(trail)
}

class Converter {
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly options: OmmlOptions
	private depth = 0

	constructor(document: XmlDocument, namespaces: Namespaces, options: OmmlOptions) {
		this.document = document
		this.namespaces = namespaces
		this.options = options
	}

	group(node: number): Group {
		if (this.document.kinds[node] !== NodeKind.Element) return Group.OTHER

		const uri = this.namespaces.elementUri(node)

		if (uri === undefined) return Group.OTHER
		if (MATH_URIS.has(uri)) return Group.MATH
		if (WORD_URIS.has(uri)) return Group.WORD

		return uri === MC_NAMESPACE ? Group.MC : Group.OTHER
	}

	isMath(node: number, local: string): boolean {
		return this.group(node) === Group.MATH && this.document.localName(node) === local
	}

	// First math child element named `local`, or -1.
	child(node: number, local: string): number {
		if (node < 0) return -1

		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.isMath(child, local)) return child
		}

		return -1
	}

	children(node: number, local: string): number[] {
		const out: number[] = []
		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.isMath(child, local)) out.push(child)
		}

		return out
	}

	// An attribute in the element's own namespace ("m:val" on an m: element), else unprefixed.
	attribute(node: number, local: string): string | undefined {
		const document = this.document

		try {
			const prefix = document.prefix(node)
			const value = prefix === "" ? undefined : document.attribute(node, `${prefix}:${local}`)

			if (value !== undefined) return value

			const uri = this.namespaces.elementUri(node)

			if (uri !== undefined) {
				const scoped = this.namespaces.attribute(node, uri, local)

				if (scoped !== undefined) return scoped
			}

			return document.attribute(node, local)
		} catch {
			return undefined
		}
	}

	// m:val of a property child of `properties`; undefined when the child or the value is absent.
	value(properties: number, local: string): string | undefined {
		const node = this.child(properties, local)

		return node < 0 ? undefined : this.attribute(node, "val")
	}

	// An ST_OnOff property: on when present without m:val or with 1/on/true.
	flag(properties: number, local: string): boolean {
		const node = this.child(properties, local)

		if (node < 0) return false

		const value = this.attribute(node, "val")

		return value === undefined || value === "1" || value === "on" || value === "true"
	}

	// Whether an ST_OnOff property is explicitly off.
	off(properties: number, local: string): boolean {
		const node = this.child(properties, local)

		if (node < 0) return false

		const value = this.attribute(node, "val")

		return value === "0" || value === "off" || value === "false"
	}

	text(node: number): string {
		const document = this.document
		let out = ""

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kinds[child]

			if (kind !== NodeKind.Text && kind !== NodeKind.CData) continue

			try {
				out += document.text(child)
			} catch {
				// A bad character reference: the text is unreadable, not the equation.
			}
		}

		return out
	}

	// Converts the content of `node` into `out`.
	content(node: number, out: Item[], flags: number): void {
		if (this.depth >= MAX_NESTING) return

		this.depth++

		const document = this.document

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			this.node(child, out, flags)
		}

		this.depth--
	}

	node(node: number, out: Item[], flags: number): void {
		const document = this.document
		const local = document.localName(node)

		switch (this.group(node)) {
			case Group.MATH:
				this.mathObject(node, local, out, flags)
				break
			case Group.WORD:
				// Revision and container wrappers hold math runs.
				if (local === "r") {
					this.wordRun(node, out, flags)
				} else if (local === "ins" || local === "moveTo" || local === "del" || local === "moveFrom") {
					this.revision(node, local === "del" || local === "moveFrom", out, flags)
				} else if (local !== "rPr" && local !== "sdtPr" && local !== "sdtEndPr") {
					this.content(node, out, flags)
				}

				break
			case Group.MC: {
				if (local !== "AlternateContent") break

				const branch = selectAlternateContent(this.namespaces, node, uri => MATH_URIS.has(uri) || WORD_URIS.has(uri))

				if (branch >= 0) this.content(branch, out, flags)

				break
			}
			default:
				this.content(node, out, flags)
		}
	}

	// What a revision wrapper holds, as the view shows it: hidden (deleted content in the final view, inserted
	// content in the original), as it is, or marked (the markup view).
	revision(node: number, deleted: boolean, out: Item[], flags: number): void {
		const view = this.options.revisions?.view ?? "final"

		if (view === (deleted ? "final" : "original")) return
		if (view !== "markup") {
			this.content(node, out, flags)

			return
		}

		const items: Item[] = []

		this.content(node, items, flags)
		this.marked(items, revisionAttribute(deleted, this.author(node)), out)
	}

	author(node: number): number {
		const author = this.options.revisions?.author

		return author === undefined ? -1 : author(this.attribute(node, "author"))
	}

	// Elements of `items` in rows marked `revision` (alignment points and breaks stay between them).
	marked(items: readonly Item[], revision: number, out: Item[]): void {
		let run: MathElement[] = []
		const flush = (): void => {
			if (run.length > 0) out.push(element("mrow", run, { revision }))

			run = []
		}

		for (const item of items) {
			if (item === ALIGN || item === BREAK) {
				flush()
				out.push(item)
			} else {
				run.push(item as MathElement)
			}
		}

		flush()
	}

	// The w:ins or w:del in an object's m:ctrlPr (the revision of its own characters); a deletion inside an
	// insertion (deleted since) counts as the deletion.
	control(node: number, local: string): { readonly deleted: boolean; readonly node: number } | undefined {
		const control = this.child(this.child(node, `${local}Pr`), "ctrlPr")

		if (control < 0) return undefined

		const document = this.document

		for (let child = document.firstChildElement(control); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.group(child) !== Group.WORD) continue

			const name = document.localName(child)

			if (name === "del") return { deleted: true, node: child }
			if (name !== "ins") continue

			for (let inner = document.firstChildElement(child); inner >= 0; inner = document.nextSiblingElement(inner))
				if (this.group(inner) === Group.WORD && document.localName(inner) === "del") return { deleted: true, node: inner }

			return { deleted: false, node: child }
		}

		return undefined
	}

	mathObject(node: number, local: string, out: Item[], flags: number): void {
		if (local !== "r" && !local.endsWith("Pr")) {
			const control = this.control(node, local)

			if (control !== undefined) {
				const view = this.options.revisions?.view ?? "final"

				if (view === (control.deleted ? "final" : "original")) return
				if (view === "markup") {
					const items: Item[] = []

					this.object(node, local, items, flags)
					this.marked(items, revisionAttribute(control.deleted, this.author(control.node)), out)

					return
				}
			}
		}

		this.object(node, local, out, flags)
	}

	object(node: number, local: string, out: Item[], flags: number): void {
		const name = flags & Flag.NAME

		switch (local) {
			case "r":
				this.run(node, out, flags)
				return
			case "f":
				out.push(this.fraction(node))
				return
			case "sSub":
				out.push(element("msub", [this.slot(node, "e", name), this.slot(node, "sub", 0)]))
				return
			case "sSup":
				out.push(element("msup", [this.slot(node, "e", name), this.slot(node, "sup", 0)]))
				return
			case "sSubSup":
				out.push(element("msubsup", [this.slot(node, "e", name), this.slot(node, "sub", 0), this.slot(node, "sup", 0)]))
				return
			case "sPre":
				out.push(
					element("mmultiscripts", [
						this.slot(node, "e", name),
						element("mprescripts", []),
						this.slot(node, "sub", 0),
						this.slot(node, "sup", 0)
					])
				)
				return
			case "rad":
				out.push(this.radical(node))
				return
			case "nary":
				out.push(this.nary(node))
				return
			case "d":
				out.push(this.delimiter(node))
				return
			case "m":
				out.push(this.matrix(node))
				return
			case "eqArr":
				out.push(this.equationArray(node))
				return
			case "func":
				out.push(this.func(node))
				return
			case "acc":
				out.push(this.accent(node))
				return
			case "bar":
				out.push(this.bar(node))
				return
			case "box":
				out.push(this.slot(node, "e", 0))
				return
			case "borderBox":
				out.push(this.borderBox(node))
				return
			case "groupChr":
				out.push(this.groupCharacter(node))
				return
			case "limLow":
				out.push(element("munder", [this.slot(node, "e", name), this.slot(node, "lim", 0)]))
				return
			case "limUpp":
				out.push(element("mover", [this.slot(node, "e", name), this.slot(node, "lim", 0)]))
				return
			case "phant":
				out.push(this.phantom(node))
				return
			case "ctrlPr":
			case "rPr":
				return
		}

		// Property containers belong to their object; anything else (a stray argument, a nested m:oMath, an
		// element from a later edition) is read for its content.
		if (local.endsWith("Pr")) return

		this.content(node, out, flags)
	}

	// An argument (m:e, m:num, m:sub...) as one element, with m:argPr/m:argSz as a script level change.
	slot(node: number, local: string, flags: number): MathElement {
		const argument = this.child(node, local)

		return argument < 0 ? element("mrow", []) : this.argument(argument, flags)
	}

	argument(argument: number, flags: number): MathElement {
		const items: Item[] = []

		this.content(argument, items, flags)

		const content = row(elementsOf(items))
		const size = Number.parseInt(this.value(this.child(argument, "argPr"), "argSz") ?? "0", 10)

		if (!Number.isFinite(size) || size === 0) return content

		return element("mstyle", unwrap(content), { scriptlevel: Math.max(-2, Math.min(2, -size)) })
	}

	run(node: number, out: Item[], flags: number): void {
		const document = this.document
		const properties = this.child(node, "rPr")
		const normalText = this.flag(properties, "nor")
		const literal = this.flag(properties, "lit")
		const sty = this.value(properties, "sty")
		const style = normalText ? MathStyle.NONE : mathStyle(this.value(properties, "scr"), sty)
		const upright = (flags & Flag.NAME) !== 0 || (sty === "p" && style === MathStyle.NONE)
		const color = this.color(node)
		const keepAlign = (flags & Flag.ALIGN) !== 0
		const keepBreak = (flags & Flag.BREAK) !== 0

		if (keepBreak && this.child(properties, "brk") >= 0) out.push(BREAK)
		if (keepAlign && this.flag(properties, "aln")) out.push(ALIGN)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const group = this.group(child)
			const local = document.localName(child)

			if (local === "t" && (group === Group.MATH || group === Group.WORD)) {
				const text = this.text(child)

				if (normalText || literal) {
					this.literalText(text, normalText, literal, style, upright, color, out)
				} else {
					// & marks an alignment point; a row that does not align drops it.
					const segments = text.split("&")

					for (let k = 0; k < segments.length; k++) {
						if (k > 0 && keepAlign) out.push(ALIGN)

						this.tokens(segments[k] ?? "", style, upright, (flags & Flag.NAME) !== 0, false, color, out)
					}
				}
			} else if (group === Group.WORD && (local === "br" || local === "cr")) {
				if (keepBreak) out.push(BREAK)
			} else if (group === Group.WORD && local === "tab") {
				out.push(element("mspace", [], { width: 1 }))
			}
		}
	}

	// m:nor runs are text: one mtext, spaces kept. m:lit runs keep their characters but no operator meaning.
	literalText(
		text: string,
		normalText: boolean,
		literal: boolean,
		style: MathStyle,
		upright: boolean,
		color: string | undefined,
		out: Item[]
	): void {
		if (!normalText) {
			this.tokens(text, style, upright, false, literal, color, out)

			return
		}

		// Token content is trimmed by MathML; edge spaces become no-break spaces to survive.
		// Index scans, not a regex: an unanchored " +$" backtracks over every inner run of spaces.
		const kept = keepEdgeSpaces(text)

		if (kept !== "") out.push(element("mtext", [kept], color === undefined ? undefined : { color }))
	}

	tokens(
		text: string,
		style: MathStyle,
		upright: boolean,
		groupLetters: boolean,
		literal: boolean,
		color: string | undefined,
		out: Item[]
	): void {
		if (text === "") return

		for (const token of tokenize(text, { groupLetters, literal })) {
			switch (token.kind) {
				case TokenKind.SPACE:
					out.push(element("mspace", [], { width: token.width }))
					break
				case TokenKind.NUMBER:
					out.push(element("mn", [styleText(token.text, style)], color === undefined ? undefined : { color }))
					break
				case TokenKind.OPERATOR:
					out.push(element("mo", [token.text], color === undefined ? undefined : { color }))
					break
				default: {
					const styled = styleText(token.text, style)
					// Only a single-character mi is italic by default.
					const normal = upright && [...styled].length === 1
					const attributes: MathAttributes | undefined =
						normal || color !== undefined
							? { ...(normal ? { mathvariant: "normal" as const } : {}), ...(color === undefined ? {} : { color }) }
							: undefined

					out.push(element("mi", [styled], attributes))
				}
			}
		}
	}

	// w:rPr/w:color of a math run, as validated hex.
	color(run: number): string | undefined {
		const document = this.document

		for (let child = document.firstChildElement(run); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.group(child) !== Group.WORD || document.localName(child) !== "rPr") continue

			for (let property = document.firstChildElement(child); property >= 0; property = document.nextSiblingElement(property)) {
				if (this.group(property) !== Group.WORD || document.localName(property) !== "color") continue

				const value = this.attribute(property, "val")

				return value !== undefined && /^[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : undefined
			}
		}

		return undefined
	}

	// A non-math w:r inside an equation: its text, as text.
	wordRun(node: number, out: Item[], flags: number): void {
		const document = this.document
		const color = this.color(node)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			if (this.group(child) !== Group.WORD) continue

			const local = document.localName(child)

			if (local === "t") {
				this.literalText(this.text(child), true, false, MathStyle.NONE, false, color, out)
			} else if ((local === "br" || local === "cr") && (flags & Flag.BREAK) !== 0) {
				out.push(BREAK)
			}
		}
	}

	fraction(node: number): MathElement {
		const type = this.value(this.child(node, "fPr"), "type")
		const numerator = this.slot(node, "num", 0)
		const denominator = this.slot(node, "den", 0)

		switch (type) {
			case "noBar":
				return element("mfrac", [numerator, denominator], { linethickness: 0 })
			case "lin":
				return element("mrow", [numerator, operator("/"), denominator])
			case "skw":
				// Skewed: the numerator raised and the denominator lowered around a slash.
				return element("mrow", [
					element("msup", [element("mrow", []), numerator]),
					operator("/", { stretchy: false }),
					element("msub", [element("mrow", []), denominator])
				])
			default:
				return element("mfrac", [numerator, denominator])
		}
	}

	radical(node: number): MathElement {
		const base = this.slot(node, "e", 0)
		const degree = this.child(node, "deg")
		const index = degree < 0 || this.flag(this.child(node, "radPr"), "degHide") ? undefined : this.argument(degree, 0)

		if (index === undefined || (index.tag === "mrow" && index.children.length === 0)) return element("msqrt", unwrap(base))

		return element("mroot", [base, index])
	}

	nary(node: number): MathElement {
		const properties = this.child(node, "naryPr")
		const character = this.child(properties, "chr")
		const symbol = character < 0 ? "∫" : (this.attribute(character, "val") ?? "∫")
		const code = symbol.codePointAt(0) ?? 0
		const integral = code >= INTEGRAL_FIRST && code <= INTEGRAL_LAST
		const written = this.value(properties, "limLoc")
		const location: LimitLocation =
			written === "undOvr" || written === "subSup"
				? written
				: integral
					? (this.options.integralLimits ?? "subSup")
					: (this.options.naryLimits ?? "undOvr")
		const under = location === "undOvr"
		const lower = this.child(node, "sub") >= 0 && !this.flag(properties, "subHide") ? this.slot(node, "sub", 0) : undefined
		const upper = this.child(node, "sup") >= 0 && !this.flag(properties, "supHide") ? this.slot(node, "sup", 0) : undefined
		const grow = this.flag(properties, "grow")
		const base = symbol === "" ? element("mrow", []) : operator(symbol, grow ? { largeop: true, stretchy: true } : { largeop: true })
		let op: MathElement

		if (lower !== undefined && upper !== undefined) {
			op = element(under ? "munderover" : "msubsup", [base, lower, upper])
		} else if (lower !== undefined) {
			op = element(under ? "munder" : "msub", [base, lower])
		} else if (upper !== undefined) {
			op = element(under ? "mover" : "msup", [base, upper])
		} else {
			op = base
		}

		const body = this.slot(node, "e", 0)

		return body.tag === "mrow" && body.children.length === 0 ? op : element("mrow", [op, body])
	}

	delimiter(node: number): MathElement {
		const properties = this.child(node, "dPr")
		const begin = this.child(properties, "begChr") < 0 ? "(" : (this.value(properties, "begChr") ?? "")
		const end = this.child(properties, "endChr") < 0 ? ")" : (this.value(properties, "endChr") ?? "")
		const separator = this.child(properties, "sepChr") < 0 ? "|" : (this.value(properties, "sepChr") ?? "")
		const fixed = this.off(properties, "grow")
		const out: MathElement[] = []

		if (begin !== "") out.push(operator(begin, { form: "prefix", fence: true, stretchy: !fixed }))

		const expressions = this.children(node, "e")

		for (let k = 0; k < expressions.length; k++) {
			if (k > 0 && separator !== "") out.push(operator(separator, { form: "infix", separator: true, stretchy: !fixed }))

			const expression = expressions[k]

			if (expression !== undefined) out.push(this.argument(expression, 0))
		}

		if (end !== "") out.push(operator(end, { form: "postfix", fence: true, stretchy: !fixed }))

		return element("mrow", out)
	}

	matrix(node: number): MathElement {
		const properties = this.child(node, "mPr")
		const alignments: MathColumnAlign[] = []

		for (const columns of this.children(properties, "mcs")) {
			for (const column of this.children(columns, "mc")) {
				const columnProperties = this.child(column, "mcPr")
				const count = Math.min(64, Math.max(1, Number.parseInt(this.value(columnProperties, "count") ?? "1", 10) || 1))
				const justification = this.value(columnProperties, "mcJc")
				const align: MathColumnAlign = justification === "left" ? "left" : justification === "right" ? "right" : "center"

				for (let k = 0; k < count && alignments.length < 256; k++) alignments.push(align)
			}
		}

		const rows: MathElement[] = []

		for (const matrixRow of this.children(node, "mr")) {
			const cells: MathElement[] = []
			const expressions = this.children(matrixRow, "e")

			for (let k = 0; k < expressions.length; k++) {
				const expression = expressions[k]
				const align = alignments[k] ?? "center"
				const content = expression === undefined ? element("mrow", []) : this.argument(expression, 0)

				cells.push(element("mtd", unwrap(content), align === "center" ? undefined : { columnalign: align }))
			}

			rows.push(element("mtr", cells))
		}

		return element("mtable", rows)
	}

	equationArray(node: number): MathElement {
		const lines: Item[][] = []
		let aligned = false

		for (const expression of this.children(node, "e")) {
			const items: Item[] = []

			this.content(expression, items, Flag.ALIGN)

			if (items.includes(ALIGN)) aligned = true

			lines.push(items)
		}

		return element(
			"mtable",
			lines.map(items => element("mtr", aligned ? alignedCells(items) : [element("mtd", elementsOf(items))]))
		)
	}

	func(node: number): MathElement {
		const name = this.slot(node, "fName", Flag.NAME)
		const argument = this.slot(node, "e", 0)
		const emptyName = name.tag === "mrow" && name.children.length === 0
		const emptyArgument = argument.tag === "mrow" && argument.children.length === 0

		if (emptyName) return argument
		if (emptyArgument) return name

		return element("mrow", [name, operator("\u2061"), argument])
	}

	accent(node: number): MathElement {
		const base = this.slot(node, "e", 0)
		const properties = this.child(node, "accPr")
		const character = this.child(properties, "chr") < 0 ? "\u0302" : (this.value(properties, "chr") ?? "")

		if (character === "") return base

		return element("mover", [base, operator(SPACING_ACCENTS.get(character) ?? character)], { accent: true })
	}

	bar(node: number): MathElement {
		const base = this.slot(node, "e", 0)

		if (this.value(this.child(node, "barPr"), "pos") === "top") {
			return element("mover", [base, operator("‾", { stretchy: true })], { accent: true })
		}

		return element("munder", [base, operator("_", { stretchy: true })], { accentunder: true })
	}

	borderBox(node: number): MathElement {
		const properties = this.child(node, "borderBoxPr")
		let frame = 0

		if (!this.flag(properties, "hideTop")) frame |= MathFrame.TOP
		if (!this.flag(properties, "hideBot")) frame |= MathFrame.BOTTOM
		if (!this.flag(properties, "hideLeft")) frame |= MathFrame.LEFT
		if (!this.flag(properties, "hideRight")) frame |= MathFrame.RIGHT
		if (this.flag(properties, "strikeH")) frame |= MathFrame.STRIKE_HORIZONTAL
		if (this.flag(properties, "strikeV")) frame |= MathFrame.STRIKE_VERTICAL
		if (this.flag(properties, "strikeBLTR")) frame |= MathFrame.STRIKE_UP
		if (this.flag(properties, "strikeTLBR")) frame |= MathFrame.STRIKE_DOWN

		const base = this.slot(node, "e", 0)

		return frame === 0 ? base : element("mrow", unwrap(base), { frame })
	}

	groupCharacter(node: number): MathElement {
		const base = this.slot(node, "e", 0)
		const properties = this.child(node, "groupChrPr")
		const character = this.child(properties, "chr") < 0 ? "⏟" : (this.value(properties, "chr") ?? "")

		if (character === "") return base

		const mark = operator(character, { stretchy: true })

		return this.value(properties, "pos") === "top" ? element("mover", [base, mark]) : element("munder", [base, mark])
	}

	phantom(node: number): MathElement {
		const properties = this.child(node, "phantPr")
		const show = !this.off(properties, "show")
		const zeroWidth = this.flag(properties, "zeroWid")
		const zeroAscent = this.flag(properties, "zeroAsc")
		const zeroDescent = this.flag(properties, "zeroDesc")
		const base = this.slot(node, "e", 0)
		const content = show ? unwrap(base) : [element("mphantom", unwrap(base))]

		if (!zeroWidth && !zeroAscent && !zeroDescent) return show ? base : (content[0] ?? base)

		return element("mpadded", content, {
			...(zeroWidth ? { width: 0 } : {}),
			...(zeroAscent ? { height: 0 } : {}),
			...(zeroDescent ? { depth: 0 } : {})
		})
	}

	// An m:oMath: its content, broken into lines (and aligned at & within them) when it has breaks.
	equation(node: number): MathElement[] {
		const items: Item[] = []

		this.content(node, items, Flag.ALIGN | Flag.BREAK)

		if (!items.includes(BREAK)) return elementsOf(items)

		const lines: Item[][] = [[]]

		for (const item of items) {
			if (item === BREAK) {
				lines.push([])
			} else {
				lines[lines.length - 1]?.push(item)
			}
		}

		const aligned = items.includes(ALIGN)

		return [
			element(
				"mtable",
				lines.map(line =>
					element("mtr", aligned ? alignedCells(line) : [element("mtd", elementsOf(line), { columnalign: "left" })])
				)
			)
		]
	}
}

// Cells of a row split at its alignment points; columns alternate right- and left-aligned, so each
// alignment point lines up across rows.
function alignedCells(items: readonly Item[]): MathElement[] {
	const cells: MathElement[] = []
	let current: MathElement[] = []

	const flush = (): void => {
		cells.push(element("mtd", current, { columnalign: cells.length % 2 === 0 ? "right" : "left" }))
		current = []
	}

	for (const item of items) {
		if (item === ALIGN) {
			flush()
		} else if (item !== BREAK) {
			current.push(item as MathElement)
		}
	}

	flush()

	return cells
}

function paragraphAlign(converter: Converter, paragraph: number): MathAlign {
	const value = converter.value(converter.child(paragraph, "oMathParaPr"), "jc")

	switch (value) {
		case "left":
		case "start":
			return "left"
		case "right":
		case "end":
			return "right"
		case "center":
			return "center"
		default:
			return "centerGroup"
	}
}

function displayMath(content: readonly MathElement[], align: MathAlign): MathElement | undefined {
	return content.length === 0 ? undefined : element("math", content, { display: "block", align })
}

// One display math element per m:oMath of an m:oMathPara, each with the paragraph's alignment.
export function ommlParagraphToMathTrees(document: XmlDocument, node: number, options: OmmlOptions = {}): MathElement[] {
	const converter = new Converter(document, namespacesOf(document, options.namespaces), options)

	if (!converter.isMath(node, "oMathPara")) return []

	const align = paragraphAlign(converter, node)
	const out: MathElement[] = []

	for (const equation of converter.children(node, "oMath")) {
		const math = displayMath(converter.equation(equation), align)

		if (math !== undefined) out.push(math)
	}

	return out
}

// The math element for an m:oMath (inline) or m:oMathPara (display; several equations stack as rows of an
// mtable). Undefined for anything else or an equation without content.
export function ommlToMathTree(document: XmlDocument, node: number, options: OmmlOptions = {}): MathElement | undefined {
	const converter = new Converter(document, namespacesOf(document, options.namespaces), options)

	if (converter.isMath(node, "oMath")) {
		const content = converter.equation(node)

		// What a view hides of a tracked equation may be all of it: an empty equation, not none.
		return content.length === 0 && options.revisions === undefined ? undefined : element("math", content)
	}

	if (!converter.isMath(node, "oMathPara")) return undefined

	const align = paragraphAlign(converter, node)
	const equations = converter.children(node, "oMath").map(equation => converter.equation(equation))
	const filled = equations.filter(content => content.length > 0)

	if (filled.length === 0 && options.revisions !== undefined) return element("math", [], { display: "block", align })
	if (filled.length <= 1) return displayMath(filled[0] ?? [], align)

	const columnalign: MathColumnAlign = align === "left" ? "left" : align === "right" ? "right" : "center"

	return displayMath(
		[
			element(
				"mtable",
				filled.map(content => element("mtr", [element("mtd", content, columnalign === "center" ? undefined : { columnalign })]))
			)
		],
		align
	)
}
