// Whether untrusted CSS could load anything, judged as the browser reads it: a tokenizer after CSS Syntax §3.3 and §4
// (preprocessing, then comments, strings, url tokens and escapes in that order), not regular expressions. The CSS is
// never rewritten from what was decoded: callers keep or drop the preprocessed text whole, and only a url naming one of
// the message's own parts (cid:) is replaced, token by token.

type Token =
	| {
			readonly type: "ws" | "{" | "}" | "(" | ")" | "[" | "]" | ";" | ":" | "," | "badString" | "badUrl" | "cdo" | "cdc"
			start: number
			end: number
	  }
	| { readonly type: "delim"; readonly value: string; start: number; end: number }
	| {
			readonly type: "ident" | "function" | "atKeyword" | "hash" | "string" | "url" | "number"
			readonly value: string
			start: number
			end: number
	  }

// §3.3: CRLF, CR and FF become LF, NUL and surrogates U+FFFD.
export function preprocessCss(css: string): string {
	return css
		.replace(/\r\n?|\f/g, "\n")
		.replaceAll("\0", "\ufffd")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
}

const isHex = (char: string | undefined): boolean => char !== undefined && /^[0-9a-f]$/i.test(char)
const isWhitespace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n"
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9"
const isIdentStart = (char: string | undefined): boolean => char !== undefined && (/^[a-z_]$/i.test(char) || char.charCodeAt(0) >= 0x80)
const isIdent = (char: string | undefined): boolean => isIdentStart(char) || isDigit(char) || char === "-"
const isNonPrintable = (char: string | undefined): boolean => {
	const code = char?.charCodeAt(0) ?? -1

	return (code >= 0 && code <= 8) || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f
}
const validEscape = (first: string | undefined, second: string | undefined): boolean =>
	first === "\\" && second !== "\n" && second !== undefined

class Tokenizer {
	private at = 0
	private readonly css: string

	constructor(css: string) {
		this.css = css
	}

	private char(offset = 0): string | undefined {
		return this.css[this.at + offset]
	}

	// §4.3.7, after the backslash.
	private escaped(): string {
		const first = this.css[this.at++]

		if (first === undefined) {
			return "�"
		}

		if (!isHex(first)) {
			return first
		}

		let hex = first

		while (hex.length < 6 && isHex(this.char())) {
			hex += this.css[this.at++]
		}

		if (isWhitespace(this.char())) {
			this.at++
		}

		const point = Number.parseInt(hex, 16)

		return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "�" : String.fromCodePoint(point)
	}

	private startsIdent(offset: number): boolean {
		const first = this.char(offset)
		const second = this.char(offset + 1)

		if (first === "-") {
			return isIdentStart(second) || second === "-" || validEscape(second, this.char(offset + 2))
		}

		return isIdentStart(first) || validEscape(first, second)
	}

	// Plain runs are sliced, never built a character at a time.
	private name(): string {
		let name = ""
		let run = this.at

		for (;;) {
			const char = this.char()

			if (isIdent(char)) {
				this.at++
			} else if (validEscape(char, this.char(1))) {
				name += this.css.slice(run, this.at)
				this.at++
				name += this.escaped()
				run = this.at
			} else {
				return name + this.css.slice(run, this.at)
			}
		}
	}

	// §4.3.10.
	private startsNumber(): boolean {
		const first = this.char()
		const second = this.char(1)

		if (first === "+" || first === "-") {
			return isDigit(second) || (second === "." && isDigit(this.char(2)))
		}

		return first === "." ? isDigit(second) : isDigit(first)
	}

	// §4.3.3 and §4.3.12: a sign, digits, a "." only when a digit follows it, an exponent only when a digit (after an
	// optional sign) follows it; then a unit or "%".
	private numeric(start: number): Token {
		if (this.char() === "+" || this.char() === "-") this.at++

		while (isDigit(this.char())) this.at++

		if (this.char() === "." && isDigit(this.char(1))) {
			this.at++

			while (isDigit(this.char())) this.at++
		}

		const exponent = this.char()

		if (exponent === "e" || exponent === "E") {
			const sign = this.char(1) === "+" || this.char(1) === "-" ? 1 : 0

			if (isDigit(this.char(1 + sign))) {
				this.at += 1 + sign

				while (isDigit(this.char())) this.at++
			}
		}

		if (this.startsIdent(0)) {
			this.name()
		} else if (this.char() === "%") {
			this.at++
		}

		return { type: "number", value: this.css.slice(start, this.at), start, end: this.at }
	}

	private string(quote: string, start: number): Token {
		let value = ""
		let run = this.at

		for (;;) {
			const char = this.css[this.at]

			if (char === undefined || char === quote) {
				value += this.css.slice(run, this.at)
				this.at = Math.min(this.at + 1, this.css.length)

				return { type: "string", value, start, end: this.at }
			}

			if (char === "\n") {
				return { type: "badString", start, end: this.at }
			}

			if (char === "\\") {
				value += this.css.slice(run, this.at)
				this.at++

				const next = this.char()

				if (next === "\n") {
					this.at++
				} else if (next !== undefined) {
					value += this.escaped()
				}

				run = this.at
				continue
			}

			this.at++
		}
	}

	// §4.3.6: after "url(" and its whitespace.
	private url(start: number): Token {
		let value = ""
		let run = this.at

		for (;;) {
			const char = this.css[this.at]

			if (char === undefined || char === ")") {
				value += this.css.slice(run, this.at)
				this.at = Math.min(this.at + 1, this.css.length)

				return { type: "url", value, start, end: this.at }
			}

			this.at++

			if (isWhitespace(char)) {
				value += this.css.slice(run, this.at - 1)

				while (isWhitespace(this.char())) this.at++

				if (this.char() === ")" || this.char() === undefined) {
					this.at = Math.min(this.at + 1, this.css.length)

					return { type: "url", value, start, end: this.at }
				}

				return this.badUrl(start)
			}

			if (char === '"' || char === "'" || char === "(" || isNonPrintable(char)) {
				return this.badUrl(start)
			}

			if (char === "\\") {
				if (!validEscape(char, this.char())) {
					return this.badUrl(start)
				}

				value += this.css.slice(run, this.at - 1) + this.escaped()
				run = this.at
			}
		}
	}

	private badUrl(start: number): Token {
		for (;;) {
			const char = this.css[this.at++]

			if (char === undefined || char === ")") {
				return { type: "badUrl", start, end: this.at }
			}

			if (validEscape(char, this.char())) {
				this.escaped()
			}
		}
	}

	private identLike(start: number): Token {
		const name = this.name()

		if (this.char() !== "(") {
			return { type: "ident", value: name, start, end: this.at }
		}

		this.at++

		if (name.toLowerCase() !== "url") {
			return { type: "function", value: name, start, end: this.at }
		}

		let look = this.at

		while (isWhitespace(this.css[look])) look++

		const next = this.css[look]

		if (next === '"' || next === "'") {
			return { type: "function", value: name, start, end: this.at }
		}

		this.at = look

		return this.url(start)
	}

	next(): Token | null {
		// Comments are no tokens (§4.3.2).
		while (this.char() === "/" && this.char(1) === "*") {
			const end = this.css.indexOf("*/", this.at + 2)

			this.at = end === -1 ? this.css.length : end + 2
		}

		const start = this.at
		const char = this.css[this.at]

		if (char === undefined) {
			return null
		}

		if (isWhitespace(char)) {
			while (isWhitespace(this.char())) this.at++

			return { type: "ws", start, end: this.at }
		}

		if (char === '"' || char === "'") {
			this.at++

			return this.string(char, start)
		}

		if (this.startsNumber()) {
			return this.numeric(start)
		}

		// "<!--" and "-->" are tokens of their own (§4.3.1): what follows them is read afresh.
		if (char === "<" && this.css.startsWith("!--", this.at + 1)) {
			this.at += 4

			return { type: "cdo", start, end: this.at }
		}

		if (char === "-" && this.css.startsWith("->", this.at + 1)) {
			this.at += 3

			return { type: "cdc", start, end: this.at }
		}

		if (this.startsIdent(0)) {
			return this.identLike(start)
		}

		if (char === "@" && this.startsIdent(1)) {
			this.at++

			return { type: "atKeyword", value: this.name(), start, end: this.at }
		}

		if (char === "#" && (isIdent(this.char(1)) || validEscape(this.char(1), this.char(2)))) {
			this.at++

			return { type: "hash", value: this.name(), start, end: this.at }
		}

		this.at++

		switch (char) {
			case "{":
			case "}":
			case "(":
			case ")":
			case "[":
			case "]":
			case ";":
			case ":":
			case ",":
				return { type: char, start, end: this.at }
			default:
				return { type: "delim", value: char, start, end: this.at }
		}
	}
}

// Every token of `css` (already preprocessed). For tests and debugging: the judge below streams them.
export function cssTokens(css: string): Token[] {
	const tokenizer = new Tokenizer(css)
	const tokens: Token[] = []

	for (let token = tokenizer.next(); token !== null; token = tokenizer.next()) {
		tokens.push(token)
	}

	return tokens
}

// Functions that load what they name (a string or a url inside them): url() with a string, image(), image-set(),
// cross-fade(), element() and src().
const LOADING_FUNCTIONS: ReadonlySet<string> = new Set([
	"url",
	"src",
	"image",
	"image-set",
	"-webkit-image-set",
	"cross-fade",
	"-webkit-cross-fade",
	"element",
	"-moz-element"
])
const LOADING_AT_RULES: ReadonlySet<string> = new Set(["import", "font-face"])

// A data: URL that is one clean token: an image type, parameters, and a payload of URL-safe characters only.
const CLEAN_DATA_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[a-z0-9.+-]+)*(?:;base64)?,[a-z0-9+/=%._~!$&*,;:@-]*$/i
const CID = /^\s*cid:\s*<?([^>\s]+)>?\s*$/i

// The id of a cid: url value, or null.
export function cssCid(value: string): string | null {
	return CID.exec(value)?.[1] ?? null
}

// Resolves a part of the message (a cid: id) to its local URL; null for none.
export type PartResolver = (id: string) => string | null

interface Replacement {
	readonly start: number
	readonly end: number
	readonly local: string
}

// One chunk's verdict, fed a token at a time: whether it could load from outside the message, and where a url naming
// one of its parts is to be replaced. Holds offsets only, never the tokens.
class ChunkJudge {
	loads = false
	replacements: Replacement[] = []
	// A url( function seen: where it starts, and its string argument once read.
	private pending: { start: number; value: string | null } | null = null
	private readonly resolve: PartResolver

	constructor(resolve: PartResolver) {
		this.resolve = resolve
	}

	// A url value: one clean data:image token, or a part of the message (kept, or replaced by its local URL).
	private url(value: string, start: number, end: number): void {
		if (CLEAN_DATA_IMAGE.test(value)) {
			return
		}

		const part = cssCid(value)
		const local = part === null ? null : this.resolve(part)

		if (local === null) {
			this.loads = true
		} else {
			this.replacements.push({ start, end, local })
		}
	}

	feed(token: Token): void {
		const pending = this.pending

		if (pending !== null) {
			if (token.type === "ws") {
				return
			}

			if (pending.value === null && token.type === "string") {
				pending.value = token.value

				return
			}

			this.pending = null

			if (pending.value !== null && token.type === ")") {
				this.url(pending.value, pending.start, token.end)

				return
			}

			// url( holding anything but one string.
			this.loads = true
		}

		switch (token.type) {
			case "badUrl":
			case "badString":
				this.loads = true
				break
			case "url":
				this.url(token.value, token.start, token.end)
				break
			case "atKeyword":
				if (LOADING_AT_RULES.has(token.value.toLowerCase())) this.loads = true
				break
			case "function": {
				const name = token.value.toLowerCase()

				if (name === "url") {
					this.pending = { start: token.start, value: null }
				} else if (LOADING_FUNCTIONS.has(name)) {
					this.loads = true
				}

				break
			}
			default:
				break
		}
	}

	// The verdict once the chunk ended (an unclosed url( loads).
	finish(): boolean {
		if (this.pending !== null) {
			this.pending = null
			this.loads = true
		}

		return this.loads
	}
}

// Whether a CSS value could load anything from outside the message.
export function cssValueLoads(css: string, resolve: PartResolver): boolean {
	const tokenizer = new Tokenizer(preprocessCss(css))
	const judge = new ChunkJudge(resolve)

	for (let token = tokenizer.next(); token !== null && !judge.loads; token = tokenizer.next()) {
		judge.feed(token)
	}

	return judge.finish()
}

export interface KeptCss {
	// The kept chunks as preprocessed, their parts' urls replaced.
	readonly css: string
	// Chunks dropped because they could load from outside the message.
	readonly dropped: number
}

// CSS split into chunks, each kept or dropped whole while it streams: a style sheet's top-level statements (ending at
// ";") and blocks (ending at their closing "}", an @media block whole), or a declaration list's declarations (split at
// semicolons inside no block, parenthesis or bracket).
export function keptCss(css: string, mode: "sheet" | "declarations", resolve: PartResolver): KeptCss {
	const text = preprocessCss(css)
	const tokenizer = new Tokenizer(text)
	const kept: string[] = []
	let dropped = 0
	let judge = new ChunkJudge(resolve)
	let start = -1
	let end = -1
	let depth = 0

	const close = (): void => {
		if (judge.finish()) {
			dropped++
		} else if (start === -1) {
			kept.push("")
		} else {
			let out = ""
			let at = start

			for (const replacement of judge.replacements) {
				out += `${text.slice(at, replacement.start)}url('${replacement.local}')`
				at = replacement.end
			}

			kept.push(out + text.slice(at, end))
		}

		judge = new ChunkJudge(resolve)
		start = -1
	}

	for (let token = tokenizer.next(); token !== null; token = tokenizer.next()) {
		if (mode === "declarations" && token.type === ";" && depth === 0) {
			close()
			continue
		}

		if (start === -1) start = token.start

		end = token.end
		judge.feed(token)

		if (mode === "sheet") {
			if (token.type === "{") {
				depth++
			} else if (token.type === "}" && depth > 0) {
				depth--

				if (depth === 0) close()
			} else if (token.type === ";" && depth === 0) {
				close()
			}
		} else if (token.type === "{" || token.type === "(" || token.type === "[" || token.type === "function") {
			depth++
		} else if ((token.type === "}" || token.type === ")" || token.type === "]") && depth > 0) {
			depth--
		}
	}

	// A sheet's unfinished last chunk; a declaration list's last declaration, even an empty one.
	if (start !== -1 || mode === "declarations") close()

	return { css: kept.join(mode === "sheet" ? "" : ";"), dropped }
}
