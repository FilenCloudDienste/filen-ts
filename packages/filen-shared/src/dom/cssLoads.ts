// Whether untrusted CSS could load anything, judged as the browser reads it: a tokenizer after CSS Syntax §3.3 and §4
// (preprocessing, then comments, strings, url tokens and escapes in that order), not regular expressions. The CSS is
// never rewritten from what was decoded: callers keep or drop the preprocessed text whole, and only a url naming one of
// the message's own parts (cid:) is replaced, token by token.

type Token =
	| { readonly type: "ws" | "{" | "}" | "(" | ")" | "[" | "]" | ";" | ":" | "," | "badString" | "badUrl"; start: number; end: number }
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

	private name(): string {
		let name = ""

		for (;;) {
			const char = this.char()

			if (isIdent(char)) {
				name += char
				this.at++
			} else if (validEscape(char, this.char(1))) {
				this.at++
				name += this.escaped()
			} else {
				return name
			}
		}
	}

	private string(quote: string, start: number): Token {
		let value = ""

		for (;;) {
			const char = this.css[this.at++]

			if (char === undefined || char === quote) {
				return { type: "string", value, start, end: this.at }
			}

			if (char === "\n") {
				this.at--

				return { type: "badString", start, end: this.at }
			}

			if (char === "\\") {
				const next = this.char()

				if (next === undefined) {
					continue
				}

				if (next === "\n") {
					this.at++
					continue
				}

				value += this.escaped()
				continue
			}

			value += char
		}
	}

	// §4.3.6: after "url(" and its whitespace.
	private url(start: number): Token {
		let value = ""

		for (;;) {
			const char = this.css[this.at++]

			if (char === undefined || char === ")") {
				return { type: "url", value, start, end: this.at }
			}

			if (isWhitespace(char)) {
				while (isWhitespace(this.char())) this.at++

				if (this.char() === ")" || this.char() === undefined) {
					this.at = Math.min(this.at + 1, this.css.length)

					return { type: "url", value, start, end: this.at }
				}

				return this.badUrl(start)
			}

			if (char === "\"" || char === "'" || char === "(" || isNonPrintable(char)) {
				return this.badUrl(start)
			}

			if (char === "\\") {
				if (!validEscape(char, this.char())) {
					return this.badUrl(start)
				}

				value += this.escaped()
				continue
			}

			value += char
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

		if (next === "\"" || next === "'") {
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

		if (char === "\"" || char === "'") {
			this.at++

			return this.string(char, start)
		}

		if (
			isDigit(char) ||
			((char === "+" || char === "-" || char === ".") && (isDigit(this.char(1)) || (this.char(1) === "." && isDigit(this.char(2)))))
		) {
			this.at++

			while (isDigit(this.char()) || this.char() === ".") this.at++

			if (this.startsIdent(0)) {
				this.name()
			} else if (this.char() === "%") {
				this.at++
			}

			return { type: "number", value: this.css.slice(start, this.at), start, end: this.at }
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

// A url() value that loads nothing from outside: one clean data:image token, or a part of the message.
function localValue(value: string, isPart: (id: string) => boolean): boolean {
	const part = cssCid(value)

	return CLEAN_DATA_IMAGE.test(value) || (part !== null && isPart(part))
}

// The url() of a url function with a string argument: the string's value, or null when the function holds anything
// else.
function urlFunctionValue(tokens: readonly Token[], open: number): { value: string; close: number } | null {
	let at = open + 1

	while (tokens[at]?.type === "ws") at++

	const string = tokens[at]

	if (string?.type !== "string") {
		return null
	}

	at++

	while (tokens[at]?.type === "ws") at++

	return tokens[at]?.type === ")" ? { value: string.value, close: at } : null
}

// Whether the tokens could load anything from outside the message.
export function tokensLoad(tokens: readonly Token[], isPart: (id: string) => boolean): boolean {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]

		if (token === undefined) {
			continue
		}

		switch (token.type) {
			case "badUrl":
			case "badString":
				return true
			case "url":
				if (!localValue(token.value, isPart)) {
					return true
				}

				break
			case "atKeyword":
				if (LOADING_AT_RULES.has(token.value.toLowerCase())) {
					return true
				}

				break
			case "function": {
				const name = token.value.toLowerCase()

				if (!LOADING_FUNCTIONS.has(name)) {
					break
				}

				const url = name === "url" ? urlFunctionValue(tokens, index) : null

				if (url === null || !localValue(url.value, isPart)) {
					return true
				}

				break
			}
			default:
				break
		}
	}

	return false
}

// The CSS of tokens [from, to) with every url naming a resolved part replaced by its local URL; any other text as it
// was (preprocessed).
export function withParts(css: string, tokens: readonly Token[], resolve: (id: string) => string | null): string {
	let out = ""
	let at = tokens[0]?.start ?? 0

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]

		if (token === undefined) {
			continue
		}

		let value: string | null = null
		let end = token.end

		if (token.type === "url") {
			value = token.value
		} else if (token.type === "function" && token.value.toLowerCase() === "url") {
			const url = urlFunctionValue(tokens, index)

			if (url !== null) {
				value = url.value
				end = tokens[url.close]?.end ?? end
				index = url.close
			}
		}

		const part = value === null ? null : cssCid(value)
		const local = part === null ? null : resolve(part)

		if (local !== null) {
			out += `${css.slice(at, token.start)}url('${local}')`
			at = end
		}
	}

	return out + css.slice(at, tokens.at(-1)?.end ?? at)
}

// Tokens split into top-level chunks: statements ending at ";" and blocks ending at their closing "}" (an @media block
// whole).
export function topLevelChunks(tokens: readonly Token[]): Token[][] {
	const chunks: Token[][] = []
	let current: Token[] = []
	let depth = 0

	for (const token of tokens) {
		current.push(token)

		if (token.type === "{") {
			depth++
		} else if (token.type === "}" && depth > 0) {
			depth--

			if (depth === 0) {
				chunks.push(current)
				current = []
			}
		} else if (token.type === ";" && depth === 0) {
			chunks.push(current)
			current = []
		}
	}

	if (current.length > 0) {
		chunks.push(current)
	}

	return chunks
}

// Tokens of a declaration list split at its top-level semicolons (inside no block, parenthesis or bracket).
export function declarationChunks(tokens: readonly Token[]): Token[][] {
	const chunks: Token[][] = []
	let current: Token[] = []
	let depth = 0

	for (const token of tokens) {
		if (token.type === ";" && depth === 0) {
			chunks.push(current)
			current = []
			continue
		}

		current.push(token)

		if (token.type === "{" || token.type === "(" || token.type === "[" || token.type === "function") {
			depth++
		} else if ((token.type === "}" || token.type === ")" || token.type === "]") && depth > 0) {
			depth--
		}
	}

	chunks.push(current)

	return chunks
}
