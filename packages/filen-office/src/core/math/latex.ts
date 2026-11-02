import { appendAll } from "../arrays"
import { MAX_OMML_NESTING, writeOmml, type OmmlContent, type OmmlNode, type OmmlScript, type OmmlStyle } from "./ommlWriter"

// The LaTeX subset equations are typed in (fractions, roots, scripts, n-ary operators with limits, fences,
// matrices and cases, Greek, operators, accents, over- and underlines, function names, \text, spacing and
// the \mathbf/\mathit/\mathrm alphabets), read into Office Math. Scripts and arguments take one token or a
// group, as in LaTeX; an n-ary operator or a function name takes the item after its limits as its operand.

export type LatexErrorCode = "empty" | "tooLong" | "tooDeep" | "unknownCommand" | "missingArgument" | "unbalanced" | "unexpected"

export interface LatexError {
	readonly code: LatexErrorCode
	// UTF-16 offset into the source where reading stopped.
	readonly offset: number
	// The command or character concerned, when there is one.
	readonly token?: string
}

export type LatexRead = { readonly ok: true; readonly content: OmmlContent } | { readonly ok: false; readonly error: LatexError }

export type LatexOmml = { readonly ok: true; readonly omml: string } | { readonly ok: false; readonly error: LatexError }

// Longest source read (UTF-16 units).
export const MAX_LATEX_LENGTH = 10_000

// ---- vocabulary ------------------------------------------------------------------------------------------

// Commands that stand for one character: Greek (LaTeX's \epsilon and \phi are the lunate forms, as in Word's
// math autocorrect), then operators, relations, arrows and symbols. Where several name one character the
// first is the one OMML is written back as.
export const LATEX_SYMBOLS: ReadonlyMap<string, string> = new Map([
	["alpha", "α"],
	["beta", "β"],
	["gamma", "γ"],
	["delta", "δ"],
	["epsilon", "ϵ"],
	["varepsilon", "ε"],
	["zeta", "ζ"],
	["eta", "η"],
	["theta", "θ"],
	["vartheta", "ϑ"],
	["iota", "ι"],
	["kappa", "κ"],
	["varkappa", "ϰ"],
	["lambda", "λ"],
	["mu", "μ"],
	["nu", "ν"],
	["xi", "ξ"],
	["omicron", "ο"],
	["pi", "π"],
	["varpi", "ϖ"],
	["rho", "ρ"],
	["varrho", "ϱ"],
	["sigma", "σ"],
	["varsigma", "ς"],
	["tau", "τ"],
	["upsilon", "υ"],
	["phi", "ϕ"],
	["varphi", "φ"],
	["chi", "χ"],
	["psi", "ψ"],
	["omega", "ω"],
	["Gamma", "Γ"],
	["Delta", "Δ"],
	["Theta", "Θ"],
	["Lambda", "Λ"],
	["Xi", "Ξ"],
	["Pi", "Π"],
	["Sigma", "Σ"],
	["Upsilon", "Υ"],
	["Phi", "Φ"],
	["Psi", "Ψ"],
	["Omega", "Ω"],
	["pm", "±"],
	["mp", "∓"],
	["times", "×"],
	["div", "÷"],
	["cdot", "⋅"],
	["ast", "∗"],
	["star", "⋆"],
	["circ", "∘"],
	["bullet", "∙"],
	["oplus", "⊕"],
	["ominus", "⊖"],
	["otimes", "⊗"],
	["oslash", "⊘"],
	["odot", "⊙"],
	["cap", "∩"],
	["cup", "∪"],
	["sqcap", "⊓"],
	["sqcup", "⊔"],
	["vee", "∨"],
	["lor", "∨"],
	["wedge", "∧"],
	["land", "∧"],
	["setminus", "∖"],
	["uplus", "⊎"],
	["dagger", "†"],
	["ddagger", "‡"],
	["leq", "≤"],
	["le", "≤"],
	["geq", "≥"],
	["ge", "≥"],
	["neq", "≠"],
	["ne", "≠"],
	["equiv", "≡"],
	["approx", "≈"],
	["sim", "∼"],
	["simeq", "≃"],
	["cong", "≅"],
	["propto", "∝"],
	["ll", "≪"],
	["gg", "≫"],
	["prec", "≺"],
	["succ", "≻"],
	["preceq", "⪯"],
	["succeq", "⪰"],
	["subset", "⊂"],
	["supset", "⊃"],
	["subseteq", "⊆"],
	["supseteq", "⊇"],
	["sqsubseteq", "⊑"],
	["sqsupseteq", "⊒"],
	["in", "∈"],
	["notin", "∉"],
	["ni", "∋"],
	["perp", "⊥"],
	["parallel", "∥"],
	["mid", "∣"],
	["nmid", "∤"],
	["vdash", "⊢"],
	["dashv", "⊣"],
	["models", "⊨"],
	["asymp", "≍"],
	["doteq", "≐"],
	["to", "→"],
	["rightarrow", "→"],
	["leftarrow", "←"],
	["gets", "←"],
	["leftrightarrow", "↔"],
	["Rightarrow", "⇒"],
	["Leftarrow", "⇐"],
	["Leftrightarrow", "⇔"],
	["implies", "⟹"],
	["Longrightarrow", "⟹"],
	["impliedby", "⟸"],
	["Longleftarrow", "⟸"],
	["iff", "⟺"],
	["Longleftrightarrow", "⟺"],
	["mapsto", "↦"],
	["longrightarrow", "⟶"],
	["longleftarrow", "⟵"],
	["longleftrightarrow", "⟷"],
	["uparrow", "↑"],
	["downarrow", "↓"],
	["updownarrow", "↕"],
	["Uparrow", "⇑"],
	["Downarrow", "⇓"],
	["nearrow", "↗"],
	["searrow", "↘"],
	["swarrow", "↙"],
	["nwarrow", "↖"],
	["hookrightarrow", "↪"],
	["hookleftarrow", "↩"],
	["rightleftharpoons", "⇌"],
	["forall", "∀"],
	["exists", "∃"],
	["nexists", "∄"],
	["neg", "¬"],
	["lnot", "¬"],
	["partial", "∂"],
	["nabla", "∇"],
	["infty", "∞"],
	["emptyset", "∅"],
	["varnothing", "∅"],
	["aleph", "ℵ"],
	["hbar", "ℏ"],
	["ell", "ℓ"],
	["wp", "℘"],
	["Re", "ℜ"],
	["Im", "ℑ"],
	["angle", "∠"],
	["triangle", "△"],
	["prime", "′"],
	["ldots", "…"],
	["dots", "…"],
	["cdots", "⋯"],
	["vdots", "⋮"],
	["ddots", "⋱"],
	["therefore", "∴"],
	["because", "∵"],
	["top", "⊤"],
	["bot", "⊥"],
	["langle", "⟨"],
	["rangle", "⟩"],
	["lfloor", "⌊"],
	["rfloor", "⌋"],
	["lceil", "⌈"],
	["rceil", "⌉"],
	["Vert", "‖"],
	["vert", "|"],
	["backslash", "\\"],
	["colon", ":"]
])

// Characters a backslash escapes, and the spacing commands as the Unicode spaces of their widths (\, 3/18 em,
// \: 4/18 em, \; the nearest to 5/18 em).
const ESCAPED: ReadonlyMap<string, string> = new Map([
	["{", "{"],
	["}", "}"],
	["#", "#"],
	["%", "%"],
	["&", "&"],
	["_", "_"],
	["$", "$"],
	["|", "‖"],
	[" ", " "],
	[",", " "],
	[":", " "],
	[">", " "],
	[";", " "]
])

const SPACE_COMMANDS: ReadonlyMap<string, string> = new Map([
	["quad", " "],
	["qquad", "  "],
	["enspace", " "],
	["thinspace", " "]
])

// How the spaces the subset makes are written back.
export const LATEX_SPACES: ReadonlyMap<string, string> = new Map([
	[" ", "\\ "],
	[" ", "~"],
	[" ", "\\,"],
	[" ", "\\:"],
	[" ", "\\;"],
	[" ", "\\quad "],
	[" ", "\\enspace "]
])

export const LATEX_NARY: ReadonlyMap<string, string> = new Map([
	["sum", "∑"],
	["prod", "∏"],
	["coprod", "∐"],
	["int", "∫"],
	["iint", "∬"],
	["iiint", "∭"],
	["oint", "∮"],
	["oiint", "∯"],
	["oiiint", "∰"],
	["bigcup", "⋃"],
	["bigcap", "⋂"],
	["bigvee", "⋁"],
	["bigwedge", "⋀"],
	["bigoplus", "⨁"],
	["bigotimes", "⨂"],
	["bigodot", "⨀"],
	["biguplus", "⨄"],
	["bigsqcup", "⨆"]
])

export interface LatexFunction {
	// The name as written (m:fName).
	readonly name: string
	// Its scripts are limits, written below and above it (m:limLow / m:limUpp).
	readonly limits: boolean
}

export const LATEX_FUNCTIONS: ReadonlyMap<string, LatexFunction> = new Map([
	["sin", { name: "sin", limits: false }],
	["cos", { name: "cos", limits: false }],
	["tan", { name: "tan", limits: false }],
	["cot", { name: "cot", limits: false }],
	["sec", { name: "sec", limits: false }],
	["csc", { name: "csc", limits: false }],
	["arcsin", { name: "arcsin", limits: false }],
	["arccos", { name: "arccos", limits: false }],
	["arctan", { name: "arctan", limits: false }],
	["sinh", { name: "sinh", limits: false }],
	["cosh", { name: "cosh", limits: false }],
	["tanh", { name: "tanh", limits: false }],
	["coth", { name: "coth", limits: false }],
	["log", { name: "log", limits: false }],
	["ln", { name: "ln", limits: false }],
	["lg", { name: "lg", limits: false }],
	["exp", { name: "exp", limits: false }],
	["dim", { name: "dim", limits: false }],
	["ker", { name: "ker", limits: false }],
	["deg", { name: "deg", limits: false }],
	["arg", { name: "arg", limits: false }],
	["hom", { name: "hom", limits: false }],
	["lim", { name: "lim", limits: true }],
	["liminf", { name: "lim inf", limits: true }],
	["limsup", { name: "lim sup", limits: true }],
	["max", { name: "max", limits: true }],
	["min", { name: "min", limits: true }],
	["sup", { name: "sup", limits: true }],
	["inf", { name: "inf", limits: true }],
	["det", { name: "det", limits: true }],
	["gcd", { name: "gcd", limits: true }],
	["Pr", { name: "Pr", limits: true }]
])

// Accents as the combining characters OMML's m:acc carries.
export const LATEX_ACCENTS: ReadonlyMap<string, string> = new Map([
	["hat", "̂"],
	["widehat", "̂"],
	["check", "̌"],
	["tilde", "̃"],
	["widetilde", "̃"],
	["acute", "́"],
	["grave", "̀"],
	["dot", "̇"],
	["ddot", "̈"],
	["dddot", "⃛"],
	["breve", "̆"],
	["bar", "̅"],
	["vec", "⃗"],
	["mathring", "̊"]
])

export type LatexLook = { readonly style?: OmmlStyle; readonly script?: OmmlScript }

// Alphabets: m:sty / m:scr of the letters inside.
export const LATEX_ALPHABETS: ReadonlyMap<string, LatexLook> = new Map([
	["mathrm", { style: "p" }],
	["mathbf", { style: "b" }],
	["mathit", { style: "i" }],
	["mathnormal", {}],
	["mathbb", { script: "double-struck", style: "p" }],
	["mathcal", { script: "script", style: "p" }],
	["mathscr", { script: "script", style: "p" }],
	["mathfrak", { script: "fraktur", style: "p" }],
	["mathsf", { script: "sans-serif", style: "p" }],
	["mathtt", { script: "monospace", style: "p" }]
])

// Fences after \left, \middle and \right ("" for none): commands, then characters.
export const LATEX_FENCES: ReadonlyMap<string, string> = new Map([
	["{", "{"],
	["}", "}"],
	["|", "‖"],
	["langle", "⟨"],
	["rangle", "⟩"],
	["lfloor", "⌊"],
	["rfloor", "⌋"],
	["lceil", "⌈"],
	["rceil", "⌉"],
	["vert", "|"],
	["Vert", "‖"],
	["lvert", "|"],
	["rvert", "|"],
	["lVert", "‖"],
	["rVert", "‖"],
	["uparrow", "↑"],
	["downarrow", "↓"],
	["updownarrow", "↕"]
])

const FENCE_CHARACTERS: ReadonlyMap<string, string> = new Map([
	["(", "("],
	[")", ")"],
	["[", "["],
	["]", "]"],
	["|", "|"],
	["/", "/"],
	[".", ""],
	// Word's \left{ and \right} for \left\{ and \right\}.
	["{", "{"],
	["}", "}"],
	["<", "⟨"],
	[">", "⟩"]
])

// Matrix environments by their fences; cases is a brace before an equation array.
export const LATEX_MATRICES: ReadonlyMap<string, readonly [string, string]> = new Map([
	["matrix", ["", ""]],
	["pmatrix", ["(", ")"]],
	["bmatrix", ["[", "]"]],
	["Bmatrix", ["{", "}"]],
	["vmatrix", ["|", "|"]],
	["Vmatrix", ["‖", "‖"]]
])

// Commands that only size or style what follows in LaTeX; read and left out.
const IGNORED = new Set([
	"displaystyle",
	"textstyle",
	"scriptstyle",
	"scriptscriptstyle",
	"big",
	"Big",
	"bigg",
	"Bigg",
	"bigl",
	"bigr",
	"bigm",
	"Bigl",
	"Bigr",
	"Bigm",
	"biggl",
	"biggr",
	"biggm",
	"Biggl",
	"Biggr",
	"Biggm",
	"!"
])

// Word's letters of an alphabet by name (\doubleR, \scriptL, \frakturg: its math autocorrect list).
const WORD_LETTERS = /^(double|script|fraktur)([A-Za-z])$/
const WORD_SCRIPTS: Readonly<Record<string, OmmlScript>> = { double: "double-struck", script: "script", fraktur: "fraktur" }

// Word's infix limits (a\below{b}, a\above{b}).
const INFIX: ReadonlySet<string> = new Set(["below", "above"])

// What \text{} escapes besides \textbackslash.
export const LATEX_TEXT_ESCAPES: ReadonlySet<string> = new Set(["{", "}", "$", "%", "&", "#", "_"])

// ---- reading -----------------------------------------------------------------------------------------------

// What a script attaches to: a token's node, or a group's nodes.
interface Atom {
	readonly nodes: OmmlNode[]
	// A group of scripts alone ({_a^b}): Word's prescripts of the item after it.
	readonly prescript?: Extract<OmmlNode, { kind: "script" }>
}

// What ends a list besides the end of the source.
const Stop = { BRACE: 1, BRACKET: 2, TABLE: 4, FENCE: 8, LINES: 16 } as const
// Where an argument or operand cannot start.
const ARGUMENT_END = Stop.BRACE | Stop.TABLE | Stop.FENCE | Stop.LINES

class LatexFailure extends Error {
	readonly error: LatexError

	constructor(error: LatexError) {
		super(error.code)
		this.error = error
	}
}

function fail(code: LatexErrorCode, offset: number, token?: string): never {
	throw new LatexFailure(token === undefined ? { code, offset } : { code, offset, token })
}

type Run = Extract<OmmlNode, { kind: "run" }>

function sameLook(a: Run, b: Run): boolean {
	return a.style === b.style && a.script === b.script && a.normal === b.normal
}

// Nodes with adjacent runs of the same look joined.
function merged(nodes: readonly OmmlNode[]): OmmlNode[] {
	const out: OmmlNode[] = []

	for (const node of nodes) {
		const last = out[out.length - 1]

		if (node.kind === "run" && last?.kind === "run" && sameLook(last, node))
			out[out.length - 1] = { ...last, text: last.text + node.text }
		else out.push(node)
	}

	return out
}

function run(text: string, look: LatexLook, normal = false): Run {
	return {
		kind: "run",
		text,
		...(look.style === undefined ? {} : { style: look.style }),
		...(look.script === undefined ? {} : { script: look.script }),
		...(normal ? { normal: true } : {})
	}
}

function isLetter(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

// Code points XML cannot carry, or that carry nothing.
function unreadable(code: number): boolean {
	return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
}

class Reader {
	private pos: number
	private depth = 0
	private readonly src: string
	private readonly end: number
	private readonly display: boolean

	constructor(src: string, start: number, end: number, display: boolean) {
		this.src = src
		this.pos = start
		this.end = end
		this.display = display
	}

	read(): OmmlNode[] {
		const out: OmmlNode[] = []

		for (;;) {
			appendAll(out, this.list(Stop.LINES))

			if (this.pos >= this.end) break
			// Only \\ ends the top list: a line break, between the equations of a display.
			if (!this.display) fail("unexpected", this.pos, "\\\\")

			this.pos += 2
			out.push({ kind: "break" })
		}

		return out
	}

	private enter(offset: number): void {
		if (++this.depth > MAX_OMML_NESTING) fail("tooDeep", offset)
	}

	private leave(): void {
		this.depth--
	}

	private skipSpace(): void {
		while (this.pos < this.end) {
			const code = this.src.charCodeAt(this.pos)

			if (isSpace(code)) {
				this.pos++
			} else if (code === 0x25) {
				// A comment, to the end of its line.
				while (this.pos < this.end && this.src.charCodeAt(this.pos) !== 0x0a) this.pos++
			} else {
				return
			}
		}
	}

	// The command at `at` (its backslash), without moving: a name of letters, else the one character after
	// the backslash ("" at the end).
	private commandAt(at: number): string {
		let end = at + 1

		while (end < this.end && isLetter(this.src.charCodeAt(end))) end++

		if (end > at + 1) return this.src.slice(at + 1, end)
		if (at + 1 >= this.end) return ""

		return String.fromCodePoint(this.src.codePointAt(at + 1) ?? 0)
	}

	private command(): string {
		const name = this.commandAt(this.pos)

		if (name === "") fail("unexpected", this.pos, "\\")

		this.pos += 1 + name.length

		return name
	}

	// Whether a list ending at any of `stops` ends here; consumes nothing.
	private ends(stops: number): boolean {
		if (this.pos >= this.end) return true

		const code = this.src.charCodeAt(this.pos)

		if (code === 0x7d) return (stops & Stop.BRACE) !== 0
		if (code === 0x5d) return (stops & Stop.BRACKET) !== 0
		if (code === 0x26) return (stops & Stop.TABLE) !== 0
		if (code !== 0x5c) return false

		const name = this.commandAt(this.pos)

		if (name === "\\") return (stops & (Stop.TABLE | Stop.LINES)) !== 0
		// Plain TeX's row end (\matrix{a & b \cr c & d}).
		if (name === "end" || name === "cr") return (stops & Stop.TABLE) !== 0
		if (name === "right" || name === "middle") return (stops & Stop.FENCE) !== 0

		return false
	}

	// Items up to what ends the list (left for the caller); a closer of another list is an error.
	private list(stops: number, look: LatexLook = {}): OmmlNode[] {
		const atoms: Atom[] = []

		for (;;) {
			this.skipSpace()

			if (this.ends(stops)) break

			// Word's infix limits: a\below{b}, a\above{b} (the item before as the base).
			const infix = this.src.charCodeAt(this.pos) === 0x5c ? this.commandAt(this.pos) : ""

			if (INFIX.has(infix)) {
				const start = this.pos

				this.pos += 1 + infix.length

				const limit = this.argument(start, `\\${infix}`, look)
				const base = merged(atoms.pop()?.nodes ?? [])

				atoms.push(this.scripts({ nodes: [{ kind: "limit", position: infix === "below" ? "lower" : "upper", base, limit }] }, look))
				continue
			}

			const atom = this.atom(look, stops)

			if (atom === undefined) continue

			const scripted = this.scripts(atom, look)
			const before = atoms[atoms.length - 1]

			// {_a^b}x: prescripts of x (m:sPre).
			if (before?.prescript !== undefined && scripted.nodes.length > 0 && scripted === atom) {
				atoms[atoms.length - 1] = {
					nodes: [{ kind: "script", pre: true, base: merged(atom.nodes), sub: before.prescript.sub, sup: before.prescript.sup }]
				}
			} else {
				atoms.push(scripted)
			}
		}

		return merged(atoms.flatMap(atom => atom.nodes))
	}

	// One item: a character, a group or a command with its arguments; undefined for a command read and left
	// out. `stops`: those of the list it is in.
	private atom(look: LatexLook, stops: number): Atom | undefined {
		const start = this.pos
		const code = this.src.codePointAt(this.pos) ?? 0
		const character = String.fromCodePoint(code)

		switch (character) {
			case "{": {
				this.pos++
				this.enter(start)

				const nodes = this.list(Stop.BRACE, look)

				this.close(start, "{")
				this.leave()

				const only = nodes.length === 1 ? nodes[0] : undefined

				return only?.kind === "script" && only.base.length === 0 && only.pre !== true ? { nodes, prescript: only } : { nodes }
			}
			case "}":
				return fail("unbalanced", start, "}")
			case "&":
			case "$":
			case "#":
				return fail("unexpected", start, character)
			case "^":
			case "_":
			case "'":
				// A script without a base.
				return { nodes: [] }
			case "\\":
				return this.commandAtom(look, stops)
			case "~":
				this.pos++

				return { nodes: [run(" ", look)] }
		}

		if (unreadable(code)) fail("unexpected", start, character)

		this.pos += character.length

		return { nodes: [run(character, look)] }
	}

	private close(start: number, token: string): void {
		this.skipSpace()

		if (this.pos >= this.end || this.src.charCodeAt(this.pos) !== 0x7d) fail("unbalanced", start, token)

		this.pos++
	}

	// The argument of `token` (at `start`): a group's content or one item.
	private argument(start: number, token: string, look: LatexLook = {}): OmmlNode[] {
		this.skipSpace()

		if (this.ends(ARGUMENT_END)) fail("missingArgument", start, token)

		const code = this.src.charCodeAt(this.pos)

		if (code === 0x5e || code === 0x5f || code === 0x27) fail("missingArgument", start, token)

		this.enter(start)

		let nodes: OmmlNode[]

		if (code === 0x7b) {
			const open = this.pos

			this.pos++
			nodes = this.list(Stop.BRACE, look)
			this.close(open, "{")
		} else {
			nodes = this.atom(look, 0)?.nodes ?? []
		}

		this.leave()

		return merged(nodes)
	}

	// Scripts after an item (x^2, x_i, x'): the item as their base.
	private scripts(atom: Atom, look: LatexLook): Atom {
		let sub: OmmlNode[] | null = null
		let sup: OmmlNode[] | null = null
		let caret = false

		for (;;) {
			this.skipSpace()

			if (this.pos >= this.end) break

			const code = this.src.charCodeAt(this.pos)
			const start = this.pos

			if (code === 0x27) {
				if (caret) fail("unexpected", start, "'")

				this.pos++
				sup ??= []
				sup.push(run("′", look))
			} else if (code === 0x5e) {
				if (caret) fail("unexpected", start, "^")

				this.pos++
				caret = true
				sup ??= []
				appendAll(sup, this.argument(start, "^", look))
			} else if (code === 0x5f) {
				if (sub !== null) fail("unexpected", start, "_")

				this.pos++
				sub = this.argument(start, "_", look)
			} else {
				break
			}
		}

		if (sub === null && sup === null) return atom

		const base = merged(atom.nodes)
		const only = base.length === 1 ? base[0] : undefined

		// A brace's label goes under (over) it, as Word writes \underbrace{x}_{n}.
		if (only?.kind === "groupChar" && only.position === "bot" && sup === null && sub !== null)
			return { nodes: [{ kind: "limit", position: "lower", base, limit: merged(sub) }] }
		if (only?.kind === "groupChar" && only.position === "top" && sub === null && sup !== null)
			return { nodes: [{ kind: "limit", position: "upper", base, limit: merged(sup) }] }

		return { nodes: [{ kind: "script", base, sub: sub === null ? null : merged(sub), sup: sup === null ? null : merged(sup) }] }
	}

	private commandAtom(look: LatexLook, stops: number): Atom | undefined {
		const start = this.pos
		const name = this.command()
		const token = `\\${name}`
		const symbol = LATEX_SYMBOLS.get(name) ?? ESCAPED.get(name) ?? SPACE_COMMANDS.get(name)

		if (symbol !== undefined) return { nodes: [run(symbol, look)] }
		if (IGNORED.has(name)) return undefined

		const accent = LATEX_ACCENTS.get(name)

		if (accent !== undefined) return { nodes: [{ kind: "accent", character: accent, base: this.argument(start, token, look) }] }

		const nary = LATEX_NARY.get(name)

		if (nary !== undefined) return this.nary(start, nary, look, stops)

		const fn = LATEX_FUNCTIONS.get(name)

		if (fn !== undefined) return this.function(start, [run(fn.name, { style: "p" })], fn.limits, look, stops)

		const letter = WORD_LETTERS.exec(name)

		if (letter !== null)
			return { nodes: [run(letter[2] ?? "", { script: WORD_SCRIPTS[letter[1] ?? ""] ?? "double-struck", style: "p" })] }

		const alphabet = LATEX_ALPHABETS.get(name)

		if (alphabet !== undefined) return { nodes: this.argument(start, token, { ...look, ...alphabet }) }

		switch (name) {
			case "frac":
			case "dfrac":
			case "tfrac":
			case "cfrac": {
				const numerator = this.argument(start, token, look)

				return { nodes: [{ kind: "fraction", numerator, denominator: this.argument(start, token, look) }] }
			}
			case "binom":
			case "dbinom":
			case "tbinom": {
				const numerator = this.argument(start, token, look)
				const denominator = this.argument(start, token, look)

				return {
					nodes: [
						{ kind: "delimiter", open: "(", close: ")", items: [[{ kind: "fraction", type: "noBar", numerator, denominator }]] }
					]
				}
			}
			case "sqrt":
				return { nodes: [this.radical(start, look)] }
			case "overbar":
				return { nodes: [{ kind: "bar", position: "top", base: this.argument(start, token, look) }] }
			case "rect":
			case "boxed":
				return { nodes: [{ kind: "borderBox", base: this.argument(start, token, look) }] }
			case "matrix":
				return { nodes: [this.environment(start, look, "matrix")] }
			case "overline":
			case "underline":
				return { nodes: [{ kind: "bar", position: name === "overline" ? "top" : "bot", base: this.argument(start, token, look) }] }
			case "overbrace":
			case "underbrace": {
				const top = name === "overbrace"

				return {
					nodes: [
						{
							kind: "groupChar",
							character: top ? "⏞" : "⏟",
							position: top ? "top" : "bot",
							base: this.argument(start, token, look)
						}
					]
				}
			}
			case "overset":
			case "stackrel":
			case "underset": {
				const limit = this.argument(start, token, look)
				const base = this.argument(start, token, look)

				return { nodes: [{ kind: "limit", position: name === "underset" ? "lower" : "upper", base, limit }] }
			}
			case "operatorname": {
				const limits = this.src.charCodeAt(this.pos) === 0x2a

				if (limits) this.pos++

				return this.function(start, this.argument(start, token, { style: "p" }), limits, look, stops)
			}
			case "text":
			case "textrm":
			case "mbox":
				return { nodes: this.text(start, token) }
			case "left":
				return { nodes: [this.fenced(start, look)] }
			case "begin":
				return { nodes: [this.environment(start, look)] }
			case "\\":
				return fail("unexpected", start, "\\\\")
			case "end":
			case "right":
			case "middle":
				return fail("unbalanced", start, token)
			case "limits":
			case "nolimits":
				fail("unexpected", start, token)
		}

		fail("unknownCommand", start, token)
	}

	private radical(start: number, look: LatexLook): OmmlNode {
		this.skipSpace()

		let degree: OmmlNode[] | null = null

		if (this.src.charCodeAt(this.pos) === 0x5b) {
			const open = this.pos

			this.pos++
			this.enter(open)
			degree = this.list(Stop.BRACKET, look)
			this.skipSpace()

			if (this.src.charCodeAt(this.pos) !== 0x5d) fail("unbalanced", open, "[")

			this.pos++
			this.leave()
		}

		const base = this.argument(start, "\\sqrt", look)

		return { kind: "radical", degree: degree === null || degree.length === 0 ? null : degree, base }
	}

	// Limits of an n-ary operator or a function name, in either order, \limits or \nolimits before them.
	private limits(look: LatexLook): { sub: OmmlNode[] | null; sup: OmmlNode[] | null; location: "undOvr" | "subSup" | null } {
		let sub: OmmlNode[] | null = null
		let sup: OmmlNode[] | null = null
		let location: "undOvr" | "subSup" | null = null

		for (;;) {
			this.skipSpace()

			const start = this.pos
			const code = this.src.charCodeAt(this.pos)

			if (this.pos >= this.end) break

			if (code === 0x5c) {
				const name = this.commandAt(this.pos)

				if (name !== "limits" && name !== "nolimits") break
				if (sub !== null || sup !== null) fail("unexpected", start, `\\${name}`)

				this.pos += 1 + name.length
				location = name === "limits" ? "undOvr" : "subSup"
			} else if (code === 0x5f) {
				if (sub !== null) fail("unexpected", start, "_")

				this.pos++
				sub = this.argument(start, "_", look)
			} else if (code === 0x5e) {
				if (sup !== null) fail("unexpected", start, "^")

				this.pos++
				sup = this.argument(start, "^", look)
			} else {
				break
			}
		}

		return { sub: sub === null ? null : merged(sub), sup: sup === null ? null : merged(sup), location }
	}

	// The item after an operator's limits, its operand (scripts included); nothing where the list ends.
	private operand(start: number, look: LatexLook, stops: number): OmmlNode[] {
		this.enter(start)

		let nodes: OmmlNode[] = []

		for (;;) {
			this.skipSpace()

			if (this.ends(stops | ARGUMENT_END)) break

			// An infix limit after the operator takes the operator as its base.
			if (this.src.charCodeAt(this.pos) === 0x5c && INFIX.has(this.commandAt(this.pos))) break

			const atom = this.atom(look, stops)

			if (atom !== undefined) {
				nodes = this.scripts(atom, look).nodes
				break
			}
		}

		this.leave()

		return merged(nodes)
	}

	private nary(start: number, operator: string, look: LatexLook, stops: number): Atom {
		const { sub, sup, location } = this.limits(look)

		return { nodes: [{ kind: "nary", operator, location, sub, sup, base: this.operand(start, look, stops) }] }
	}

	private function(start: number, nameNodes: OmmlNode[], limits: boolean, look: LatexLook, stops: number): Atom {
		const { sub, sup, location } = this.limits(look)

		if (location !== null) fail("unexpected", start, location === "undOvr" ? "\\limits" : "\\nolimits")

		let name: OmmlNode[] = merged(nameNodes)

		if (limits) {
			if (sub !== null) name = [{ kind: "limit", position: "lower", base: name, limit: sub }]
			if (sup !== null) name = [{ kind: "limit", position: "upper", base: name, limit: sup }]
		} else if (sub !== null || sup !== null) {
			name = [{ kind: "script", base: name, sub, sup }]
		}

		// Word's \lim\below{n}: the limit of the name, as \lim_n.
		for (;;) {
			this.skipSpace()

			const infix = this.src.charCodeAt(this.pos) === 0x5c ? this.commandAt(this.pos) : ""

			if (!INFIX.has(infix)) break

			const at = this.pos

			this.pos += 1 + infix.length
			name = [
				{ kind: "limit", position: infix === "below" ? "lower" : "upper", base: name, limit: this.argument(at, `\\${infix}`, look) }
			]
		}

		return { nodes: [{ kind: "function", name, base: this.operand(start, look, stops) }] }
	}

	// \text{...}: its characters as text (spaces kept, line ends as spaces), a few escaped.
	private text(start: number, token: string): OmmlNode[] {
		this.skipSpace()

		if (this.src.charCodeAt(this.pos) !== 0x7b) fail("missingArgument", start, token)

		this.pos++

		let out = ""
		let depth = 0

		for (;;) {
			if (this.pos >= this.end) fail("unbalanced", start, token)

			const at = this.pos
			const code = this.src.codePointAt(at) ?? 0
			const character = String.fromCodePoint(code)

			this.pos += character.length

			if (code === 0x7d) {
				if (depth === 0) break

				depth--
			} else if (code === 0x7b) {
				if (++depth > MAX_OMML_NESTING) fail("tooDeep", at)
			} else if (code === 0x5c) {
				const name = this.commandAt(at)

				if (LATEX_TEXT_ESCAPES.has(name) || name === " ") out += name
				else if (name === "textbackslash") out += "\\"
				else fail("unknownCommand", at, `\\${name}`)

				this.pos = at + 1 + name.length
			} else if (code === 0x0a || code === 0x0d || code === 0x09) {
				out += " "
			} else if (unreadable(code)) {
				fail("unexpected", at, character)
			} else {
				out += character
			}
		}

		return out === "" ? [] : [run(out, {}, true)]
	}

	// A fence after \left, \middle or \right.
	private fence(start: number, token: string): string {
		this.skipSpace()

		if (this.pos >= this.end) fail("missingArgument", start, token)

		const at = this.pos
		const code = this.src.codePointAt(at) ?? 0
		const character = String.fromCodePoint(code)

		if (code === 0x5c) {
			const name = this.command()
			const fence = LATEX_FENCES.get(name) ?? LATEX_SYMBOLS.get(name)

			if (fence === undefined) fail("unexpected", at, `\\${name}`)

			return fence
		}

		this.pos += character.length

		const fence = FENCE_CHARACTERS.get(character)

		if (fence !== undefined) return fence
		if (code < 0x80 || unreadable(code)) fail("unexpected", at, character)

		return character
	}

	private fenced(start: number, look: LatexLook): OmmlNode {
		const open = this.fence(start, "\\left")
		const items: OmmlNode[][] = []
		let separator: string | undefined

		this.enter(start)

		for (;;) {
			items.push(this.list(Stop.FENCE, look))

			if (this.pos >= this.end) fail("unbalanced", start, "\\left")

			const at = this.pos

			if (this.command() === "right") break

			const middle = this.fence(at, "\\middle")

			// OMML has one separator character per fence.
			if (separator !== undefined && separator !== middle) fail("unexpected", at, "\\middle")

			separator = middle
		}

		const close = this.fence(start, "\\right")

		this.leave()

		return { kind: "delimiter", open, close, ...(separator === undefined ? {} : { separator }), items }
	}

	private environmentName(start: number, token: string): string {
		this.skipSpace()

		if (this.src.charCodeAt(this.pos) !== 0x7b) fail("missingArgument", start, token)

		const close = this.src.indexOf("}", this.pos)

		if (close < 0 || close >= this.end) fail("unbalanced", start, token)

		const name = this.src.slice(this.pos + 1, close).trim()

		this.pos = close + 1

		return name
	}

	// \begin{name} ... \end{name}, or (`braced`: Word's \matrix{...}) a brace's rows.
	private environment(start: number, look: LatexLook, braced?: string): OmmlNode {
		if (braced !== undefined) {
			this.skipSpace()

			if (this.src.charCodeAt(this.pos) !== 0x7b) fail("missingArgument", start, `\\${braced}`)

			this.pos++
		}

		const name = braced ?? this.environmentName(start, "\\begin")
		const fences = LATEX_MATRICES.get(name)

		if (fences === undefined && name !== "cases") fail("unknownCommand", start, name)

		// The fence and the array inside it.
		this.enter(start)
		this.enter(start)

		const rows: OmmlNode[][][] = []
		let cells: OmmlNode[][] = []

		for (;;) {
			cells.push(this.list(braced === undefined ? Stop.TABLE : Stop.TABLE | Stop.BRACE, look))

			if (this.pos >= this.end) fail("unbalanced", start, braced === undefined ? `\\begin{${name}}` : `\\${braced}`)

			const at = this.pos

			if (this.src.charCodeAt(at) === 0x26) {
				this.pos++
				continue
			}

			if (braced !== undefined && this.src.charCodeAt(at) === 0x7d) {
				this.pos++
				rows.push(cells)
				break
			}

			const command = this.command()

			if (braced !== undefined && command === "end") fail("unbalanced", at, "\\end")

			rows.push(cells)
			cells = []

			if (command === "end") {
				if (this.environmentName(at, "\\end") !== name) fail("unbalanced", at, "\\end")

				break
			}
		}

		this.leave()
		this.leave()

		// A \\ before \end makes no row.
		const last = rows[rows.length - 1]

		if (rows.length > 1 && last?.length === 1 && last[0]?.length === 0) rows.pop()

		if (fences === undefined) {
			// Cases: each row's cells joined at an alignment point (& in an equation array).
			const lines = rows.map(row => merged(row.flatMap((cell, k) => (k === 0 ? cell : [run("&", look), ...cell]))))

			return { kind: "delimiter", open: "{", close: "", items: [[{ kind: "eqArray", rows: lines }]] }
		}

		const matrix: OmmlNode = { kind: "matrix", rows }

		return fences[0] === "" && fences[1] === "" ? matrix : { kind: "delimiter", open: fences[0], close: fences[1], items: [[matrix]] }
	}
}

// Where the source is without math-mode delimiters around it ($...$, $$...$$, \(...\), \[...\]) and
// surrounding space.
function bounds(latex: string): readonly [number, number] {
	let start = 0
	let end = latex.length

	while (start < end && isSpace(latex.charCodeAt(start))) start++
	while (end > start && isSpace(latex.charCodeAt(end - 1))) end--

	// A control space (\ ) at the end is content: an odd run of backslashes before it escapes it.
	let slashes = 0

	while (end - slashes - 1 >= start && latex.charCodeAt(end - slashes - 1) === 0x5c) slashes++

	if (slashes % 2 === 1 && end < latex.length) end++

	for (const [open, close] of [
		["$$", "$$"],
		["\\[", "\\]"],
		["\\(", "\\)"],
		["$", "$"]
	] as const) {
		if (end - start >= open.length + close.length && latex.startsWith(open, start) && latex.endsWith(close, end))
			return [start + open.length, end - close.length]
	}

	return [start, end]
}

function readAs(latex: string, display: boolean): LatexRead {
	if (latex.length > MAX_LATEX_LENGTH) return { ok: false, error: { code: "tooLong", offset: MAX_LATEX_LENGTH } }

	const [start, end] = bounds(latex)

	try {
		const content = new Reader(latex, start, end, display).read()

		if (!content.some(node => node.kind !== "break")) return { ok: false, error: { code: "empty", offset: start } }

		return { ok: true, content }
	} catch (error) {
		if (error instanceof LatexFailure) return { ok: false, error: error.error }

		throw error
	}
}

// Reads `latex` into Office Math, or says where and why it cannot. Line breaks (\\) separate the equations of
// a display equation.
export function readLatex(latex: string): LatexRead {
	return readAs(latex, true)
}

// `latex` as an equation's m:oMath (m:oMathPara when `display`), as writeOmml writes it; inline, a line break
// is an error.
export function latexToOmml(latex: string, display: boolean): LatexOmml {
	const read = readAs(latex, display)

	if (!read.ok) return read

	try {
		return { ok: true, omml: writeOmml(read.content, { display }) }
	} catch (error) {
		if (error instanceof RangeError) return { ok: false, error: { code: "tooDeep", offset: 0 } }

		throw error
	}
}
