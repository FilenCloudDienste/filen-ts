import { RtfTokenizer, Token } from "../rtf/tokenizer"
import { charsetCodepage, decodeCodepage } from "../rtf/codepage"

// A message's RTF body as the viewer shows it: the HTML it encapsulates ([MS-OXRTFEX] §2.1.3: \fromhtml1, HTML
// in \*\htmltag groups and in text outside \htmlrtf, the RTF-only parts suppressed), or its text. One linear pass
// over the tokens; groups nested deeper than MAX_GROUP_DEPTH are skipped whole, so the state stack is bounded and
// the output is never longer than the input.

export interface RtfBody {
	// The encapsulated HTML, for a \fromhtml1 body.
	readonly html: string | null
	// The text, for any other.
	readonly text: string | null
}

// Destinations whose text is not the body's (RTF 1.9.1 "Destinations"); any \* group is skipped too, as is an
// unknown destination there. Field results (\fldrslt) are text; instructions (\fldinst) are not.
const SKIPPED: ReadonlySet<string> = new Set([
	"author",
	"bkmkend",
	"bkmkstart",
	"buptim",
	"colortbl",
	"comment",
	"creatim",
	"datastore",
	"doccomm",
	"fldinst",
	"fonttbl",
	"footer",
	"footerf",
	"footerl",
	"footerr",
	"generator",
	"header",
	"headerf",
	"headerl",
	"headerr",
	"info",
	"keywords",
	"latentstyles",
	"listoverridetable",
	"listtable",
	"nonshppict",
	"object",
	"operator",
	"pict",
	"printim",
	"revtbl",
	"revtim",
	"rsidtbl",
	"stylesheet",
	"subject",
	"themedata",
	"title",
	"xmlnstbl"
])

const WORD_TEXT: ReadonlyMap<string, string> = new Map([
	["tab", "\t"],
	["cell", "\t"],
	["emdash", "—"],
	["endash", "–"],
	["emspace", " "],
	["enspace", " "],
	["qmspace", " "],
	["bullet", "•"],
	["lquote", "‘"],
	["rquote", "’"],
	["ldblquote", "“"],
	["rdblquote", "”"],
	["zwj", "‍"],
	["zwnj", "‌"],
	["ltrmark", "‎"],
	["rtlmark", "‏"]
])

const BREAKS: ReadonlySet<string> = new Set(["par", "line", "row", "page", "sect"])

interface State {
	codepage: number
	// Characters to skip after \uN (\ucN).
	uc: number
	// Inside \htmlrtf: RTF-only content, not part of the HTML.
	suppressed: boolean
	skipped: boolean
	fonts: boolean
}

const STAR = 0x2a
// As the RTF reader's: deeper groups are skipped whole.
const MAX_GROUP_DEPTH = 512
const PIECES = 1024

export function rtfBody(rtf: Uint8Array): RtfBody {
	const tokens = new RtfTokenizer(rtf)
	// Pieces joined a thousand at a time: a body of one-character pieces never holds millions of strings.
	const out: string[] = []
	let pieces: string[] = []
	const fonts = new Map<number, number>()
	const stack: State[] = []
	let state: State = { codepage: 1252, uc: 1, suppressed: false, skipped: false, fonts: false }
	let defaultCodepage = 1252
	let html = false
	let groupStart = false
	let starred = false
	let font = 0
	let skip = 0
	// A run of \'hh bytes, decoded together (a double-byte code page's characters span two).
	let hex = new Uint8Array(256)
	let hexLength = 0
	let shown = false

	const shows = (): boolean => !state.skipped && !(html && state.suppressed)
	const emit = (text: string): void => {
		if (!shows() || text === "") return

		shown = true
		pieces.push(text)

		if (pieces.length >= PIECES) {
			out.push(pieces.join(""))
			pieces = []
		}
	}
	const flush = (): void => {
		if (hexLength === 0) return

		const length = hexLength

		hexLength = 0
		emit(decodeCodepage(hex, 0, length, state.codepage))
	}

	for (let kind = tokens.next(); kind !== Token.End; kind = tokens.next()) {
		if (kind !== Token.Hex) flush()

		const first = groupStart

		groupStart = false

		if (kind === Token.GroupStart) {
			if (stack.length >= MAX_GROUP_DEPTH) {
				tokens.skipGroup()
				continue
			}

			stack.push(state)
			state = { ...state }
			groupStart = true
			starred = false
			skip = 0
			continue
		}

		if (kind === Token.GroupEnd) {
			const outer = stack.pop()

			if (outer === undefined) break

			state = outer
			skip = 0
			continue
		}

		if (kind === Token.Symbol && first && tokens.symbol === STAR) {
			starred = true
			groupStart = true
			continue
		}

		if (first && starred && kind !== Token.Word) state.skipped = true

		if (kind === Token.Word && first) {
			const name = tokens.name

			if (name === "fonttbl") {
				state.fonts = true
				state.skipped = true
			} else if (starred ? !(html && name === "htmltag") : SKIPPED.has(name)) {
				state.skipped = true
			}
		}

		if (kind === Token.Word) {
			const { name, param, hasParam } = tokens

			if (state.fonts) {
				if (name === "f") font = param
				else if (name === "fcharset") {
					const codepage = charsetCodepage(param)

					if (codepage !== undefined && codepage !== 0) fonts.set(font, codepage)
				} else if (name === "cpg") fonts.set(font, param)

				continue
			}

			switch (name) {
				case "ansicpg":
					defaultCodepage = param
					state.codepage = param
					break
				case "mac":
					defaultCodepage = 10000
					state.codepage = 10000
					break
				case "pc":
					defaultCodepage = 437
					state.codepage = 437
					break
				case "pca":
					defaultCodepage = 850
					state.codepage = 850
					break
				case "fromhtml":
					if (stack.length === 1 && !shown) html = param === 1
					break
				case "f":
					state.codepage = fonts.get(param) ?? defaultCodepage
					break
				case "uc":
					state.uc = Math.max(0, param)
					break
				case "u":
					emit(String.fromCharCode(param < 0 ? param + 0x10000 : param & 0xffff))
					skip = state.uc
					break
				case "htmlrtf":
					state.suppressed = !hasParam || param !== 0
					break
				default: {
					const text = WORD_TEXT.get(name)

					if (text !== undefined) emit(text)
					else if (BREAKS.has(name)) emit(html ? "\r\n" : "\n")
				}
			}

			continue
		}

		if (kind === Token.Symbol) {
			const symbol = tokens.symbol

			if (symbol === 0x0a) emit(html ? "\r\n" : "\n")
			else if (symbol === 0x7e) emit(" ")
			else if (symbol === 0x5f) emit("‑")
			else if (symbol === 0x5c || symbol === 0x7b || symbol === 0x7d) emit(String.fromCharCode(symbol))

			continue
		}

		if (kind === Token.Hex) {
			if (skip > 0) skip--
			else if (tokens.value >= 0) {
				if (hexLength === hex.length) {
					const grown = new Uint8Array(hex.length * 2)

					grown.set(hex)
					hex = grown
				}

				hex[hexLength++] = tokens.value
			}

			continue
		}

		if (kind === Token.Text) {
			let start = tokens.textStart

			if (skip > 0) {
				const skipped = Math.min(skip, tokens.textEnd - start)

				start += skipped
				skip -= skipped
			}

			emit(decodeCodepage(rtf, start, tokens.textEnd, state.codepage))
		}
	}

	flush()
	out.push(pieces.join(""))

	const body = out.join("")

	return html ? { html: body, text: null } : { html: null, text: body }
}
