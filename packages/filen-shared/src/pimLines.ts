import { platformTextDecoder, type PlatformTextDecoder } from "./bytes"
import { withoutFormatControls } from "./formatControls"

// The content lines iCalendar (RFC 5545 §3.1) and vCard (RFC 6350 §3.3, and vCard 2.1's quoted-printable) share:
// `group.NAME;PARAM=a,"b;c":value`, folded onto continuation lines that begin with a space or a tab.

export interface ContentLine {
	// Upper-cased, without its group.
	readonly name: string
	// Parameter names upper-cased; vCard 2.1's bare parameters (`TEL;HOME;VOICE`) are TYPE values.
	readonly params: ReadonlyMap<string, readonly string[]>
	// As written: escapes and encodings are the property's to undo (textValue, decodedValue).
	readonly value: string
}

export interface ContentLineCaps {
	// Lines read at most; the rest of the file is not looked at.
	readonly lines: number
	// Characters kept of one unfolded line.
	readonly lineChars: number
}

const PARAM_VALUES_MAX = 16
const NO_PARAMS: ReadonlyMap<string, readonly string[]> = new Map()

function parseParams(text: string, params: Map<string, string[]>): void {
	let at = 0

	while (at < text.length) {
		// text[at] is the `;` before a parameter.
		at++

		const equals = text.indexOf("=", at)
		const semicolon = text.indexOf(";", at)
		const nameEnd = equals === -1 || (semicolon !== -1 && semicolon < equals) ? -1 : equals

		if (nameEnd === -1) {
			const end = semicolon === -1 ? text.length : semicolon
			const bare = text.slice(at, end).trim()

			if (bare !== "") {
				const types = params.get("TYPE") ?? []

				if (types.length < PARAM_VALUES_MAX) types.push(bare)

				params.set("TYPE", types)
			}

			at = end

			continue
		}

		const name = text.slice(at, nameEnd).trim().toUpperCase()
		const values = params.get(name) ?? []

		at = nameEnd + 1

		for (;;) {
			let value: string

			if (text[at] === "\"") {
				const close = text.indexOf("\"", at + 1)
				const end = close === -1 ? text.length : close

				value = text.slice(at + 1, end)
				at = close === -1 ? text.length : close + 1
			} else {
				let end = at

				while (end < text.length && text[end] !== "," && text[end] !== ";") end++

				value = text.slice(at, end)
				at = end
			}

			if (values.length < PARAM_VALUES_MAX) values.push(value)

			if (text[at] !== ",") break

			at++
		}

		params.set(name, values)

		// Anything up to the next parameter (a stray character after a quoted value) is dropped.
		while (at < text.length && text[at] !== ";") at++
	}
}

// The `:` that ends the name and parameters: the first one outside a quoted parameter value.
function valueStart(line: string): number {
	let quoted = false

	for (let index = 0; index < line.length; index++) {
		const char = line[index]

		if (char === "\"") quoted = !quoted
		else if (char === ":" && !quoted) return index
	}

	return -1
}

function parseLine(line: string): ContentLine | null {
	const colon = valueStart(line)

	if (colon <= 0) {
		return null
	}

	const head = line.slice(0, colon)
	const semicolon = head.indexOf(";")
	const qualified = semicolon === -1 ? head : head.slice(0, semicolon)
	const name = qualified
		.slice(qualified.lastIndexOf(".") + 1)
		.trim()
		.toUpperCase()

	if (name === "") {
		return null
	}

	if (semicolon === -1) {
		return { name, params: NO_PARAMS, value: line.slice(colon + 1) }
	}

	const params = new Map<string, string[]>()

	parseParams(head.slice(semicolon), params)

	return { name, params, value: line.slice(colon + 1) }
}

function isQuotedPrintable(line: string): boolean {
	const colon = valueStart(line)

	return colon > 0 && /;\s*(?:ENCODING=)?QUOTED-PRINTABLE\s*(?:[;:]|$)/i.test(line.slice(0, colon + 1))
}

const LINE_BREAK = /\r\n|\r|\n/g

// Each content line of `text`, unfolded, handed to `visit` as it is read, up to the caps (nothing is collected). A vCard
// 2.1 quoted-printable value continues past a line that ends in `=` (a soft break).
// `visit` returns false to stop. Whether the whole text was read: false when the line cap or `visit` stopped it.
// Linear in the text: a logical line is kept as its physical pieces until it ends, and whether it is quoted-printable
// is decided once, when its name and parameters have been read.
export function eachContentLine(text: string, caps: ContentLineCaps, visit: (line: ContentLine) => boolean | void): boolean {
	const pieces: string[] = []
	let length = 0
	// Quoted-printable: null while undecided (no value colon read yet, the parameters may still be folded on).
	let quotedPrintable: boolean | null = null
	// Where the search for the value colon goes on: each piece is scanned once, quotes carried across pieces.
	const scan = { piece: 0, quoted: false }
	let read = 0
	let at = 0
	let stopped = false

	const append = (piece: string): void => {
		const kept = piece.slice(0, Math.max(0, caps.lineChars - length))

		if (kept.length > 0) {
			pieces.push(kept)
			length += kept.length
		}
	}

	const flush = (): void => {
		if (pieces.length > 0 && !stopped) {
			const line = parseLine(pieces.join(""))

			if (line !== null && visit(line) === false) stopped = true
		}

		pieces.length = 0
		length = 0
		quotedPrintable = null
		scan.piece = 0
		scan.quoted = false
	}

	// The name and parameters up to and with the value colon, once one is read; null before.
	const head = (): string | null => {
		for (; scan.piece < pieces.length; scan.piece++) {
			const piece = pieces[scan.piece] ?? ""

			for (let index = 0; index < piece.length; index++) {
				const char = piece[index]

				if (char === "\"") {
					scan.quoted = !scan.quoted
				} else if (char === ":" && !scan.quoted) {
					return pieces.slice(0, scan.piece).join("") + piece.slice(0, index + 1)
				}
			}
		}

		return null
	}

	const softBreak = (): boolean => {
		const last = pieces.at(-1)

		if (last?.endsWith("=") !== true) {
			return false
		}

		if (quotedPrintable === null) {
			const found = head()

			// No value yet: a parameter ends in "=" (folded on the next line), not a soft break. Decided once a colon is read.
			if (found === null) {
				return false
			}

			quotedPrintable = isQuotedPrintable(found)
		}

		return quotedPrintable
	}

	LINE_BREAK.lastIndex = 0

	while (at <= text.length && read < caps.lines && !stopped) {
		const match = LINE_BREAK.exec(text)
		const end = match === null ? text.length : match.index
		// A physical line is read only as far as a content line may run.
		const raw = text.slice(at, Math.min(end, at + caps.lineChars))

		at = match === null ? text.length + 1 : match.index + match[0].length
		read++

		if (pieces.length > 0 && softBreak()) {
			// The soft break's "=" goes; the next physical line continues the value.
			const last = pieces.length - 1

			pieces[last] = (pieces[last] ?? "").slice(0, -1)
			length--
			append(raw)
		} else if (pieces.length > 0 && (raw.startsWith(" ") || raw.startsWith("\t"))) {
			append(raw.slice(1))
		} else {
			flush()

			if (raw.trim() === "") continue

			append(raw)
		}
	}

	flush()

	return at > text.length && !stopped
}

export function param(line: ContentLine, name: string): string | null {
	return line.params.get(name)?.[0] ?? null
}

// TYPE values, lower-cased, split on commas (vCard 3/4 writes `TYPE=work,voice` or repeats the parameter).
export function types(line: ContentLine): string[] {
	return (line.params.get("TYPE") ?? [])
		.flatMap(value => value.split(","))
		.map(value => value.trim().toLowerCase())
		.filter(Boolean)
}

// A TEXT value with its escapes undone: `\n` / `\N` a line break, `\,` `\;` `\\` the character.
export function unescapeText(value: string): string {
	return value.replace(/\\([nN,;\\:])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char))
}

// A TEXT value's components (`;` outside escapes), each unescaped: a vCard N or ADR.
export function textComponents(value: string): string[] {
	const parts: string[] = []
	let start = 0

	for (let index = 0; index < value.length; index++) {
		if (value[index] === "\\") index++
		else if (value[index] === ";") {
			parts.push(unescapeText(value.slice(start, index)))
			start = index + 1
		}
	}

	parts.push(unescapeText(value.slice(start)))

	return parts
}

const decoders = new Map<string, PlatformTextDecoder>()

function decoderFor(charset: string | null): PlatformTextDecoder {
	const label = (charset ?? "utf-8").trim().toLowerCase()
	let decoder = decoders.get(label)

	if (decoder === undefined) {
		try {
			decoder = platformTextDecoder(label)
		} catch {
			decoder = decoders.get("utf-8") ?? platformTextDecoder("utf-8")
		}

		decoders.set(label, decoder)
	}

	return decoder
}

const QP_RUN = /(?:=[0-9a-f]{2})+/gi

// Each run of `=XX` bytes decoded in the value's charset; the rest is ASCII-compatible text kept as is.
function decodeQuotedPrintable(value: string, charset: string | null): string {
	return value.replace(QP_RUN, run => {
		const bytes = new Uint8Array(run.length / 3)

		for (let index = 0; index < bytes.length; index++) {
			bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16)
		}

		return decoderFor(charset).decode(bytes)
	})
}

// The value as text: quoted-printable decoded (vCard 2.1, in its CHARSET), escapes undone for a TEXT value.
export function decodedValue(line: ContentLine, escaped = true): string {
	const encoding = param(line, "ENCODING")
	const qp = encoding?.toUpperCase() === "QUOTED-PRINTABLE" || types(line).includes("quoted-printable")
	const value = qp ? decodeQuotedPrintable(line.value, param(line, "CHARSET")) : line.value

	return escaped ? unescapeText(value) : value
}

// Bidi and other format characters taken out (ZWJ and ZWNJ kept, which scripts need), C0 controls but tab and line
// break too, and the text capped at `max` characters.
export function displayText(text: string, max: number): string {
	let out = ""

	for (const char of withoutFormatControls(text)) {
		const code = char.codePointAt(0) ?? 0

		if (code >= 0x20 || code === 0x09 || code === 0x0a) out += char

		if (out.length >= max) return `${out.slice(0, max)}…`
	}

	return out
}
