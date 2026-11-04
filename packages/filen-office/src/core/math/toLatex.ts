import { MC_NAMESPACE, Namespaces, NodeKind, decodeUtf8, selectAlternateContent, type XmlDocument } from "../xml/index"
import {
	LATEX_ACCENTS,
	LATEX_FENCES,
	LATEX_FUNCTIONS,
	LATEX_MATRICES,
	LATEX_NARY,
	LATEX_SPACES,
	LATEX_SYMBOLS,
	LATEX_TEXT_ESCAPES
} from "./latex"
import type { OmmlOptions } from "./omml"
import { MAX_OMML_DEPTH } from "./ommlWriter"

// Office Math back to the LaTeX subset latex.ts reads, for editing an equation as text: the final equation (its
// tracked changes accepted; an edit records against them, ommlTrack.ts). What the subset cannot say (formatting,
// unsupported objects and properties) is left out and makes the result lossy; otherwise reading the LaTeX back
// gives the same equation.

export interface OmmlLatex {
	readonly latex: string
	// The equation has what the subset cannot say (formatting, unsupported elements): editing it loses that.
	readonly lossy: boolean
}

const MATH_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/officeDocument/2006/math",
	"http://purl.oclc.org/ooxml/officeDocument/math"
])

const WORD_URIS: ReadonlySet<string> = new Set([
	"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	"http://purl.oclc.org/ooxml/wordprocessingml/main"
])

function reverse(map: ReadonlyMap<string, string>, keep: (value: string) => boolean = () => true): Map<string, string> {
	const out = new Map<string, string>()

	for (const [name, value] of map) if (keep(value) && !out.has(value)) out.set(value, name)

	return out
}

const SYMBOL_NAMES = reverse(LATEX_SYMBOLS, value => value.charCodeAt(0) >= 0x80)
const NARY_NAMES = reverse(LATEX_NARY)
// Accent characters, with those MathML draws as one of the subset's (SPACING_ACCENTS in omml.ts).
const ACCENT_NAMES = new Map([...reverse(LATEX_ACCENTS), ["̄", "bar"]])
const FUNCTION_NAMES = new Map([...LATEX_FUNCTIONS].map(([command, fn]) => [fn.name, { command, limits: fn.limits }]))
const MATRIX_NAMES = new Map([...LATEX_MATRICES].map(([name, [open, close]]) => [`${open}\u0000${close}`, name]))
const FENCE_NAMES = reverse(LATEX_FENCES)
const RAW_FENCES = new Set(["(", ")", "[", "]", "|", "/"])
// Characters LaTeX gives a meaning, as the subset writes them.
const ESCAPES: ReadonlyMap<string, string> = new Map([
	["{", "\\{"],
	["}", "\\}"],
	["#", "\\#"],
	["%", "\\%"],
	["$", "\\$"],
	["_", "\\_"],
	["&", "\\&"],
	["\\", "\\backslash"],
	["‖", "\\|"]
])
// Characters the subset has no way to write in math: written as text, which changes their look.
const TEXT_ONLY = new Set(["^", "~", "'", '"', "`"])

// The alphabet command of m:scr and m:sty; null where the subset has none (lossy), "" for the default.
function alphabet(script: string | undefined, sty: string | undefined): string | null {
	switch (script) {
		case undefined:
		case "roman":
			return sty === "p" ? "mathrm" : sty === "b" ? "mathbf" : sty === "bi" ? null : ""
		case "double-struck":
			return sty === "b" || sty === "bi" ? null : "mathbb"
		case "script":
			return sty === "b" || sty === "bi" ? null : "mathcal"
		case "fraktur":
			return sty === "b" || sty === "bi" ? null : "mathfrak"
		case "sans-serif":
			return sty === "p" ? "mathsf" : null
		case "monospace":
			return "mathtt"
		default:
			return null
	}
}

function isLetter(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

// Whether `latex` ends in a command name (a letter after it would run into the name).
function endsInName(latex: string): boolean {
	let at = latex.length - 1

	if (at < 0 || !isLetter(latex.charCodeAt(at))) return false

	while (at >= 0 && isLetter(latex.charCodeAt(at))) at--

	return at >= 0 && latex.charCodeAt(at) === 0x5c
}

// `parts` concatenated, a space where a command name would run into letters.
function join(parts: readonly string[]): string {
	let out = ""
	// Whether `out` ends in a command name, and its last two characters, kept as parts are added (reading `out`
	// again each time is quadratic: slicing a concatenated string flattens it).
	let name = false
	let tail = ""

	for (const part of parts) {
		if (part === "") continue
		const first = part.charCodeAt(0)

		// After a command name, and (for reading's sake) after a one-character script: x_i y, not x_iy.
		if ((name && isLetter(first)) || (/^[_^][A-Za-z0-9]$/.test(tail) && /[A-Za-z0-9]/.test(part.charAt(0)))) {
			out += " "
			tail = `${tail.slice(-1)} `
			name = false
		}

		name = endsInName(part) || (name && /^[A-Za-z]+$/.test(part))
		out += part
		tail = part.length >= 2 ? part.slice(-2) : `${tail}${part}`.slice(-2)
	}

	return out
}

// A script or limit: bare when it is one letter or digit.
function scriptArgument(latex: string): string {
	return /^[A-Za-z0-9]$/.test(latex) ? latex : `{${latex}}`
}

// A script's base: bare when it is one character or one command without arguments.
function base(latex: string): string {
	return [...latex].length === 1 || /^\\[A-Za-z]+$/.test(latex) ? latex : `{${latex}}`
}

class Writer {
	lossy = false
	// Inside \operatorname{...}: its runs read back upright.
	private upright = false
	// Each math run's w:rPr as written (one string per formatting).
	readonly runFormats = new Set<string>()
	private depth = 0
	private readonly document: XmlDocument
	private readonly namespaces: Namespaces

	constructor(document: XmlDocument, namespaces: Namespaces) {
		this.document = document
		this.namespaces = namespaces
	}

	private uri(node: number): string | undefined {
		return this.document.kinds[node] === NodeKind.Element ? this.namespaces.elementUri(node) : undefined
	}

	isMath(node: number, local?: string): boolean {
		const uri = this.uri(node)

		return uri !== undefined && MATH_URIS.has(uri) && (local === undefined || this.document.localName(node) === local)
	}

	private isWord(node: number, local: string): boolean {
		const uri = this.uri(node)

		return uri !== undefined && WORD_URIS.has(uri) && this.document.localName(node) === local
	}

	private child(node: number, local: string): number {
		if (node < 0) return -1

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child))
			if (this.isMath(child, local)) return child

		return -1
	}

	children(node: number, local: string): number[] {
		const out: number[] = []

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child))
			if (this.isMath(child, local)) out.push(child)

		return out
	}

	private elements(node: number): number[] {
		const out: number[] = []

		if (node < 0) return out

		for (let child = this.document.firstChildElement(node); child >= 0; child = this.document.nextSiblingElement(child)) out.push(child)

		return out
	}

	// m:val of property `local` of `properties` (or its unprefixed val); undefined when either is absent.
	private value(properties: number, local: string): string | undefined {
		const node = this.child(properties, local)

		if (node < 0) return undefined

		const uri = this.uri(node)
		const scoped = uri === undefined ? undefined : this.namespaces.attribute(node, uri, "val")

		return scoped ?? this.document.attribute(node, "val")
	}

	private has(node: number, local: string): boolean {
		return this.child(node, local) >= 0
	}

	private flag(properties: number, local: string): boolean {
		if (!this.has(properties, local)) return false

		const value = this.value(properties, local)

		return value === undefined || value === "1" || value === "on" || value === "true"
	}

	// Property children of `properties` other than `known` (and m:ctrlPr) are what the subset cannot carry.
	private otherProperties(properties: number, known: readonly string[]): void {
		for (const child of this.elements(properties)) {
			if (this.isMath(child, "ctrlPr")) this.control(child)
			else if (!this.isMath(child) || !known.includes(this.document.localName(child))) this.lossy = true
		}
	}

	// m:ctrlPr: formatting of an object's characters, or a revision of them (kept by an edit: ommlTrack.ts).
	private control(node: number): void {
		for (const child of this.elements(node)) {
			if (this.isWord(child, "rPr")) continue
			else if (!this.isWord(child, "ins") && !this.isWord(child, "del")) this.lossy = true
		}
	}

	// Whether an object's characters are deleted (tracked): the final equation, which LaTeX says, has no such object.
	private deletedObject(node: number, local: string): boolean {
		const control = this.child(this.child(node, `${local}Pr`), "ctrlPr")

		for (const child of this.elements(control)) {
			if (this.isWord(child, "del")) return true
			if (this.isWord(child, "ins") && this.elements(child).some(inner => this.isWord(inner, "del"))) return true
		}

		return false
	}

	// w:rPr of a math run: an edit keeps each run's and gives what is new the first run's, so runs formatted
	// alike lose nothing; runs formatted otherwise do (see ommlToLatex). Control characters keep theirs.
	private formatting(rPr: number): void {
		const document = this.document

		this.runFormats.add(decodeUtf8(document.bytes, document.start(rPr), document.end(rPr)))
	}

	// An argument (m:e, m:num...); a size change of it (m:argPr) is lossy.
	private argument(node: number): string {
		if (node < 0) return ""

		this.otherProperties(this.child(node, "argPr"), [])

		return this.content(node, false)
	}

	private slot(node: number, local: string): string {
		return this.argument(this.child(node, local))
	}

	content(node: number, align: boolean): string {
		// Deeper than an equation is read (MAX_OMML_DEPTH elements): left out, lossy.
		if (++this.depth > MAX_OMML_DEPTH) {
			this.depth--
			this.lossy = true

			return ""
		}

		const latex = join(this.elements(node).map(child => this.node(child, align)))

		this.depth--

		return latex
	}

	private node(node: number, align: boolean): string {
		const local = this.document.localName(node)

		if (this.isMath(node)) return this.object(node, local, align)

		const uri = this.uri(node)

		if (uri !== undefined && WORD_URIS.has(uri)) {
			// Tracked changes: LaTeX says the final equation; an edit keeps the changes (ommlTrack.ts).
			switch (local) {
				case "ins":
				case "moveTo":
					return this.content(node, align)
				case "del":
				case "moveFrom":
					return ""
				case "r":
					this.lossy = true
					return this.wordRun(node)
				// Range markers stay with the equation's paragraph when it is written again.
				case "bookmarkStart":
				case "bookmarkEnd":
				case "commentRangeStart":
				case "commentRangeEnd":
				case "proofErr":
				case "permStart":
				case "permEnd":
					return ""
			}
		}

		this.lossy = true

		if (uri === MC_NAMESPACE && local === "AlternateContent") {
			const branch = selectAlternateContent(this.namespaces, node, value => MATH_URIS.has(value) || WORD_URIS.has(value))

			return branch < 0 ? "" : this.content(branch, align)
		}

		return this.content(node, align)
	}

	private object(node: number, local: string, align: boolean): string {
		if (local !== "r" && !local.endsWith("Pr") && this.deletedObject(node, local)) return ""

		switch (local) {
			case "r":
				return this.run(node, align)
			case "f":
				return this.fraction(node)
			case "rad":
				return this.radical(node)
			case "sSub":
			case "sSup":
			case "sSubSup":
				this.otherProperties(this.child(node, `${local}Pr`), [])

				return this.scripted(base(this.slot(node, "e")), node, local !== "sSup", local !== "sSub")
			case "sPre":
				// Word's prescripts, {_a^b}x.
				this.otherProperties(this.child(node, "sPrePr"), [])

				return `{${this.scripted("", node, true, true)}}${base(this.slot(node, "e"))}`
			case "nary":
				return this.nary(node)
			case "d":
				return this.delimiter(node)
			case "m":
				return this.matrix(node, "matrix")
			case "eqArr":
				this.lossy = true
				this.otherProperties(this.child(node, "eqArrPr"), [])

				return `\\begin{matrix}${this.children(node, "e")
					.map(row => this.argument(row))
					.join(" \\\\ ")}\\end{matrix}`
			case "func":
				return this.func(node)
			case "acc": {
				const properties = this.child(node, "accPr")
				const character = this.has(properties, "chr") ? (this.value(properties, "chr") ?? "") : "̂"
				const name = ACCENT_NAMES.get(character)

				this.otherProperties(properties, ["chr"])

				if (name === undefined) this.lossy = true

				return `\\${name ?? "hat"}{${this.slot(node, "e")}}`
			}
			case "bar": {
				const properties = this.child(node, "barPr")

				this.otherProperties(properties, ["pos"])

				return `\\${this.value(properties, "pos") === "top" ? "overline" : "underline"}{${this.slot(node, "e")}}`
			}
			case "groupChr":
				return this.groupCharacter(node)
			case "limLow":
			case "limUpp":
				return this.limit(node, local === "limLow")
			case "borderBox":
				// A box all round (Word's \rect).
				if (this.elements(this.child(node, "borderBoxPr")).some(child => !this.isMath(child, "ctrlPr"))) this.lossy = true

				this.otherProperties(this.child(node, "borderBoxPr"), [])

				return `\\rect{${this.slot(node, "e")}}`
			case "box":
			case "phant":
				this.lossy = true

				return `{${this.slot(node, "e")}}`
			case "oMath":
				return this.content(node, align)
		}

		this.lossy = true

		return local.endsWith("Pr") ? "" : this.content(node, align)
	}

	private run(node: number, align: boolean): string {
		const properties = this.child(node, "rPr")
		const text = this.runText(node)

		this.otherProperties(properties, ["nor", "sty", "scr"])

		if (this.flag(properties, "nor")) return text === "" ? "" : `\\text{${textLatex(text, this)}}`

		const command = alphabet(this.value(properties, "scr"), this.value(properties, "sty"))

		// An italic run in an \operatorname reads back upright.
		if (command === null || (command === "" && this.upright && text !== "")) this.lossy = true

		const body = this.math(text, align)

		return command === null || command === "" || body === "" ? body : `\\${command}{${body}}`
	}

	// A math run's text; anything else in it but its properties is lossy.
	private runText(node: number): string {
		let text = ""
		let formatted = false

		for (const child of this.elements(node)) {
			if (this.isMath(child, "t")) {
				text += this.text(child)
			} else if (this.isWord(child, "rPr")) {
				this.formatting(child)
				formatted = true
			} else if (!this.isMath(child, "rPr")) {
				this.lossy = true
			}
		}

		if (!formatted) this.runFormats.add("")

		return text
	}

	private text(node: number): string {
		let out = ""

		for (let child = this.document.firstChild(node); child >= 0; child = this.document.nextSibling(child)) {
			const kind = this.document.kinds[child]

			if (kind !== NodeKind.Text && kind !== NodeKind.CData) continue

			try {
				out += this.document.text(child)
			} catch {
				this.lossy = true
			}
		}

		return out
	}

	// Run text in math: characters with a command as it, LaTeX's own characters escaped.
	private math(text: string, align: boolean): string {
		const parts: string[] = []

		for (const character of text) {
			const code = character.codePointAt(0) ?? 0
			const symbol = SYMBOL_NAMES.get(character)
			const space = LATEX_SPACES.get(character)
			const escaped = ESCAPES.get(character)

			if (character === "&" && align) {
				parts.push("&")
			} else if (symbol !== undefined) {
				parts.push(`\\${symbol}`)
			} else if (space !== undefined) {
				parts.push(space)
			} else if (escaped !== undefined) {
				parts.push(escaped)
			} else if (TEXT_ONLY.has(character)) {
				this.lossy = true
				parts.push(`\\text{${character}}`)
			} else if (code < 0x20 || code === 0x7f || code === 0xfffe || code === 0xffff) {
				this.lossy = true
			} else {
				parts.push(character)
			}
		}

		return join(parts)
	}

	// A w:r inside an equation: its text, as text.
	private wordRun(node: number): string {
		let text = ""

		for (const child of this.elements(node)) if (this.isWord(child, "t")) text += this.text(child)

		return text === "" ? "" : `\\text{${textLatex(text, this)}}`
	}

	private fraction(node: number): string {
		const properties = this.child(node, "fPr")
		const type = this.value(properties, "type")

		this.otherProperties(properties, ["type"])

		if (type !== undefined && type !== "bar") this.lossy = true

		return `\\frac{${this.slot(node, "num")}}{${this.slot(node, "den")}}`
	}

	private radical(node: number): string {
		const properties = this.child(node, "radPr")
		const degree = this.flag(properties, "degHide") ? "" : this.slot(node, "deg")

		this.otherProperties(properties, ["degHide"])

		const index = /[[\]]/.test(degree) ? `{${degree}}` : degree

		return degree === "" ? `\\sqrt{${this.slot(node, "e")}}` : `\\sqrt[${index}]{${this.slot(node, "e")}}`
	}

	private scripted(baseLatex: string, node: number, sub: boolean, sup: boolean): string {
		let out = baseLatex

		if (sub) out += `_${scriptArgument(this.slot(node, "sub"))}`
		if (sup) out += `^${scriptArgument(this.slot(node, "sup"))}`

		return out
	}

	// An n-ary operator, with \limits / \nolimits only where the equation says where its limits go (else the
	// document's default stays).
	private nary(node: number): string {
		const properties = this.child(node, "naryPr")
		const operator = this.has(properties, "chr") ? (this.value(properties, "chr") ?? "") : "∫"
		const name = NARY_NAMES.get(operator)
		const location = this.value(properties, "limLoc")
		let out = `\\${name ?? "int"}`

		this.otherProperties(properties, ["chr", "limLoc", "subHide", "supHide"])

		if (name === undefined) this.lossy = true
		if (location === "undOvr") out += "\\limits"
		else if (location === "subSup") out += "\\nolimits"
		if (this.has(node, "sub") && !this.flag(properties, "subHide")) out += `_${scriptArgument(this.slot(node, "sub"))}`
		if (this.has(node, "sup") && !this.flag(properties, "supHide")) out += `^${scriptArgument(this.slot(node, "sup"))}`

		return join([out, base(this.slot(node, "e"))])
	}

	private fence(character: string, side: "left" | "right" | "middle"): string {
		const name = FENCE_NAMES.get(character)

		if (character === "") return `\\${side}.`
		if (RAW_FENCES.has(character)) return `\\${side}${character}`
		if (name !== undefined) return isLetter(name.charCodeAt(0)) ? `\\${side}\\${name} ` : `\\${side}\\${name}`
		if ((character.codePointAt(0) ?? 0) < 0x80) this.lossy = true

		return `\\${side}${character}`
	}

	private delimiter(node: number): string {
		const properties = this.child(node, "dPr")
		const open = this.has(properties, "begChr") ? (this.value(properties, "begChr") ?? "") : "("
		const close = this.has(properties, "endChr") ? (this.value(properties, "endChr") ?? "") : ")"
		const separator = this.has(properties, "sepChr") ? (this.value(properties, "sepChr") ?? "") : "|"
		const items = this.children(node, "e")
		const only = items.length === 1 ? (items[0] ?? -1) : -1
		const inner = only < 0 || this.has(only, "argPr") ? [] : this.elements(only)
		const single = inner.length === 1 ? (inner[0] ?? -1) : -1

		this.otherProperties(properties, ["begChr", "endChr", "sepChr", "shp", "grow"])

		// A fence that keeps its size.
		if (this.has(properties, "grow") && !this.flag(properties, "grow")) this.lossy = true

		if (single >= 0) {
			const matrix = MATRIX_NAMES.get(`${open}\u0000${close}`)

			if (matrix !== undefined && this.isMath(single, "m")) return this.matrix(single, matrix)
			if (open === "{" && close === "" && this.isMath(single, "eqArr")) return this.cases(single)
			if (open === "(" && close === ")" && this.isMath(single, "f") && this.value(this.child(single, "fPr"), "type") === "noBar") {
				this.otherProperties(this.child(single, "fPr"), ["type"])

				return `\\binom{${this.slot(single, "num")}}{${this.slot(single, "den")}}`
			}
		}

		const parts = [this.fence(open, "left")]

		items.forEach((item, k) => {
			if (k > 0) parts.push(this.fence(separator, "middle"))

			parts.push(this.argument(item))
		})
		parts.push(this.fence(close, "right"))

		return join(parts)
	}

	private matrix(node: number, environment: string): string {
		for (const child of this.elements(this.child(node, "mPr"))) {
			if (this.isMath(child, "mcs")) {
				for (const column of this.children(child, "mc")) {
					const columnProperties = this.child(column, "mcPr")
					const justification = this.value(columnProperties, "mcJc")

					this.otherProperties(columnProperties, ["count", "mcJc"])

					if (justification !== undefined && justification !== "center") this.lossy = true
				}
			} else if (this.isMath(child, "ctrlPr")) {
				this.control(child)
			} else {
				this.lossy = true
			}
		}

		const cells = this.children(node, "mr").map(row => this.children(row, "e"))

		// Rows of other lengths: written back, each gets the longest's cells.
		if (cells.some(row => row.length !== (cells[0]?.length ?? 0))) this.lossy = true

		const rows = cells.map(row => row.map(cell => this.argument(cell)).join(" & "))

		return `\\begin{${environment}}${rows.join(" \\\\ ")}\\end{${environment}}`
	}

	private cases(node: number): string {
		this.otherProperties(this.child(node, "eqArrPr"), [])

		const rows = this.children(node, "e").map(row => {
			this.otherProperties(this.child(row, "argPr"), [])

			return this.content(row, true)
		})

		return `\\begin{cases}${rows.join(" \\\\ ")}\\end{cases}`
	}

	private groupCharacter(node: number): string {
		const properties = this.child(node, "groupChrPr")
		const character = this.has(properties, "chr") ? (this.value(properties, "chr") ?? "") : "⏟"
		const top = this.value(properties, "pos") === "top"

		this.otherProperties(properties, ["chr", "pos", "vertJc"])

		if (character !== (top ? "⏞" : "⏟")) this.lossy = true

		return `\\${top ? "overbrace" : "underbrace"}{${this.slot(node, "e")}}`
	}

	// The one element an argument holds, or -1.
	private only(node: number, local: string): number {
		const argument = this.child(node, local)

		if (argument < 0 || this.has(argument, "argPr")) return -1

		const elements = this.elements(argument)

		return elements.length === 1 ? (elements[0] ?? -1) : -1
	}

	private limit(node: number, lower: boolean): string {
		const group = this.only(node, "e")

		this.otherProperties(this.child(node, lower ? "limLowPr" : "limUppPr"), [])

		const limit = this.slot(node, "lim")

		// A brace's label (\underbrace{x}_{n}).
		if (group >= 0 && this.isMath(group, "groupChr") && (this.value(this.child(group, "groupChrPr"), "pos") === "top") !== lower)
			return `${this.groupCharacter(group)}${lower ? "_" : "^"}${scriptArgument(limit)}`

		return `\\${lower ? "underset" : "overset"}{${limit}}{${this.slot(node, "e")}}`
	}

	// m:func: a known name as its command, any other as \operatorname; its limits or scripts after it.
	private func(node: number): string {
		this.otherProperties(this.child(node, "funcPr"), [])

		const operand = base(this.slot(node, "e"))
		// The element holding the name, under any limits or scripts.
		let holder = this.child(node, "fName")
		let core = this.only(node, "fName")
		let scripts = ""
		let limits: boolean | undefined

		if (core >= 0 && this.isMath(core, "limUpp")) {
			scripts = `^${scriptArgument(this.slot(core, "lim"))}`
			limits = true
			holder = this.child(core, "e")
			core = this.only(core, "e")

			if (core >= 0 && this.isMath(core, "limLow")) {
				scripts = `_${scriptArgument(this.slot(core, "lim"))}${scripts}`
				holder = this.child(core, "e")
				core = this.only(core, "e")
			}
		} else if (core >= 0 && this.isMath(core, "limLow")) {
			scripts = `_${scriptArgument(this.slot(core, "lim"))}`
			limits = true
			holder = this.child(core, "e")
			core = this.only(core, "e")
		} else if (core >= 0 && (this.isMath(core, "sSub") || this.isMath(core, "sSup") || this.isMath(core, "sSubSup"))) {
			const local = this.document.localName(core)

			scripts = this.scripted("", core, local !== "sSup", local !== "sSub")
			limits = false
			holder = this.child(core, "e")
			core = this.only(core, "e")
		}

		if (core < 0 || !this.isMath(core, "r")) {
			// A name the subset reads as \operatorname over its content, upright, its scripts after it.
			const upright = this.upright

			this.upright = true

			const name = this.argument(holder)

			this.upright = upright

			return join([`\\operatorname${limits === true ? "*" : ""}{${name}}`, scripts, operand])
		}

		const properties = this.child(core, "rPr")
		const text = this.runText(core)
		const known = FUNCTION_NAMES.get(text)

		this.otherProperties(properties, ["sty"])

		if (known !== undefined && (limits === undefined || known.limits === limits)) return join([`\\${known.command}`, scripts, operand])

		return join([`\\operatorname${limits === true ? "*" : ""}{${this.math(text, false)}}`, scripts, operand])
	}

	paragraph(node: number): string {
		const properties = this.child(node, "oMathParaPr")
		const jc = this.value(properties, "jc")

		this.otherProperties(properties, ["jc"])

		if (jc !== undefined && jc !== "centerGroup") this.lossy = true

		return this.children(node, "oMath")
			.map(equation => this.content(equation, false))
			.join(" \\\\ ")
	}
}

// \text{} content: its escapes; tabs and line ends become spaces.
function textLatex(text: string, writer: Writer): string {
	let out = ""

	for (const character of text) {
		if (LATEX_TEXT_ESCAPES.has(character)) {
			out += `\\${character}`
		} else if (character === "\\") {
			out += "\\textbackslash "
		} else if (character === "\n" || character === "\r" || character === "\t") {
			writer.lossy = true
			out += " "
		} else {
			out += character
		}
	}

	return out
}

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

// The m:oMath or m:oMathPara element `node` of `document` as LaTeX, a display's equations on lines of their
// own (\\). Anything else is empty and lossy.
export function ommlToLatex(document: XmlDocument, node: number, options: OmmlOptions = {}): OmmlLatex {
	const writer = new Writer(document, namespacesOf(document, options.namespaces))
	let latex: string

	if (writer.isMath(node, "oMathPara")) latex = writer.paragraph(node)
	else if (writer.isMath(node, "oMath")) latex = writer.content(node, false)
	else return { latex: "", lossy: true }

	// Runs formatted otherwise than each other: what an edit makes new is formatted as the first.
	return { latex, lossy: writer.lossy || writer.runFormats.size > 1 }
}
