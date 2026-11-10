import { field, hasControl, intArg, stringArg, type DocxCommandInfo, type DocxCommandParser } from "./base"

// Links, breaks and characters.

// A link goes to a URL (`target`, written as an external relationship, never fetched), to a bookmark in the
// document (`anchor`), or to a heading of the story (`heading`: its paragraph's position), through the hidden
// _Toc bookmark Word's Place in This Document links by (the heading's own, or one made around its text); `text`
// is inserted as the link's text when the selection is empty.
export type InsertCommand =
	| { readonly type: "link.set"; readonly target: string; readonly text?: string }
	| { readonly type: "link.set"; readonly anchor: string; readonly text?: string }
	| { readonly type: "link.set"; readonly heading: number; readonly text?: string }
	| { readonly type: "link.remove" }
	| { readonly type: "insert.pageBreak" }
	| { readonly type: "insert.lineBreak" }
	// Word's horizontal line: an empty paragraph with a bottom border (AutoFormat's "---").
	| { readonly type: "insert.horizontalLine" }
	// Characters from a symbol picker (Unicode text, one or a few characters). U+2011 and U+00AD become Word's
	// nonbreaking and optional hyphens.
	| { readonly type: "insert.symbol"; readonly text: string }

export const INSERT_COMMANDS: readonly DocxCommandInfo<InsertCommand["type"]>[] = [
	// Word's Ctrl+K (Cmd+K): the host asks for the link.
	{
		type: "link.set",
		labelKey: "docx.link.set",
		icon: "link",
		shortcut: "mod+k",
		hostShortcut: true,
		group: "link",
		write: true,
		scope: "story",
		input: "link"
	},
	{ type: "link.remove", labelKey: "docx.link.remove", icon: "unlink", group: "link", write: true, scope: "story" },
	{
		type: "insert.pageBreak",
		labelKey: "docx.insert.pageBreak",
		icon: "page-break",
		shortcut: "mod+enter",
		group: "insert",
		write: true,
		scope: "story"
	},
	{ type: "insert.lineBreak", labelKey: "docx.insert.lineBreak", icon: "line-break", group: "insert", write: true, scope: "story" },
	{
		type: "insert.horizontalLine",
		labelKey: "docx.insert.horizontalLine",
		icon: "horizontal-line",
		group: "insert",
		write: true,
		scope: "story"
	},
	{
		type: "insert.symbol",
		labelKey: "docx.insert.symbol",
		icon: "symbol",
		// No key of Word's; one a user binds opens the host's picker.
		hostShortcut: true,
		group: "insert",
		write: true,
		scope: "story",
		input: "text"
	}
]

// URLs a link may hold (as typed; what opening one allows is the app's link policy).
export const MAX_LINK_TARGET = 2048
// Word's bookmark names.
const BOOKMARK_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
export const MAX_LINK_TEXT = 1024
// A grapheme or a few (a flag, a family emoji): what a symbol picker inserts at once.
const MAX_SYMBOL = 16

// Text XML can hold: no controls but tab, no noncharacters or lone surrogates.
export function insertable(text: string): boolean {
	for (let k = 0; k < text.length; k++) {
		const code = text.charCodeAt(k)

		if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(k + 1) & 0xfc00) === 0xdc00) k++
		else if (
			(code < 0x20 && code !== 0x09) ||
			code === 0x7f ||
			(code >= 0xd800 && code <= 0xdfff) ||
			code === 0xfffe ||
			code === 0xffff
		)
			return false
	}

	return true
}

// Why a link target cannot be written: it holds a control character or a lone surrogate, which no URI reference
// carries, encoded or not; or (a new target only) its scheme is none a link made here may have.
export type DocxLinkTargetRefusal = "control" | "surrogate" | "scheme"

// The schemes a new link may go to: web, email and phone addresses (a place in the document is an anchor).
// Whatever else a file links to (file:, javascript:, an app's own scheme) runs nothing in the browser but is
// not written by this editor.
const LINK_SCHEME = /^(?:https?:\/\/|mailto:|tel:)/i

// Why link.set refuses a target, or undefined when it takes it. The target the link at the selection already
// has (current, as the file holds it) stays whatever its scheme, so a link's text is edited without its target.
export function linkTargetRefusal(target: string, current?: string | null): DocxLinkTargetRefusal | undefined {
	const written = linkTargetUri(target)

	if ("refusal" in written) return written.refusal

	return written.uri === current ||
		(typeof current === "string" && written.uri === writtenLinkTarget(current)) ||
		LINK_SCHEME.test(written.uri)
		? undefined
		: "scheme"
}

// A target as a file's relationship holds it, whatever made it (a copy of a file's link): linkTargetUri, with
// what no URI reference carries encoded too, a control as its byte (RFC 3986 §2.1) and a lone surrogate as
// U+FFFD, so a save always has a URI to write.
export function writtenLinkTarget(target: string): string {
	let safe = ""

	for (let k = 0; k < target.length; k++) {
		const code = target.charCodeAt(k)

		if (code < 0x20 || code === 0x7f) safe += `%${code.toString(16).toUpperCase().padStart(2, "0")}`
		else if (code >= 0xd800 && code <= 0xdbff && (target.charCodeAt(k + 1) & 0xfc00) === 0xdc00) {
			safe += target.slice(k, k + 2)
			k++
		} else if (code >= 0xd800 && code <= 0xdfff) safe += "\ufffd"
		else safe += target[k] ?? ""
	}

	const written = linkTargetUri(safe)

	return "uri" in written ? written.uri : safe
}

// ASCII a URI reference holds as is (RFC 3986 §2: unreserved, reserved and "%"), by code.
const URI_ASCII = (() => {
	const out = new Uint8Array(128)

	for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&'()*+,;=%") out[char.charCodeAt(0)] = 1

	return out
})()
// An authority whose host is an IP literal (RFC 3986 §3.2.2): its brackets are the only ones a URI holds as is.
const IP_LITERAL = /^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/(?:[^/?#@[\]]*@)?)(\[[^\]/?#]*\])/
const HEX = "0123456789ABCDEF"

// A link target as the URI reference the file holds (ECMA-376 Part 2 §9.3: a relationship's Target is an
// xsd:anyURI): what RFC 3986 does not allow is percent-encoded as UTF-8 (space, quotes, angle brackets, braces,
// a "%" not starting an escape, a second "#", brackets outside an IP literal, non-ASCII), as Word writes a typed
// address; what is valid stays as it is, so a target already encoded comes back unchanged.
export function linkTargetUri(target: string): { readonly uri: string } | { readonly refusal: DocxLinkTargetRefusal } {
	const literal = IP_LITERAL.exec(target)
	const hostFrom = literal === null ? -1 : (literal[1] ?? "").length
	const hostTo = literal === null ? -1 : hostFrom + (literal[2] ?? "").length
	let out = ""
	let fragment = false
	const byte = (value: number): void => {
		out += `%${HEX[value >> 4] ?? ""}${HEX[value & 15] ?? ""}`
	}

	for (let k = 0; k < target.length; k++) {
		const code = target.charCodeAt(k)

		if (code < 0x20 || code === 0x7f) return { refusal: "control" }

		if (code < 0x80) {
			const char = target[k] ?? ""
			const kept =
				URI_ASCII[code] === 1 &&
				(code !== 0x25 || /^[0-9A-Fa-f]{2}$/.test(target.slice(k + 1, k + 3))) &&
				(code !== 0x23 || !fragment) &&
				((code !== 0x5b && code !== 0x5d) || (k >= hostFrom && k < hostTo))

			if (code === 0x23) fragment = true

			if (kept) out += char
			else byte(code)

			continue
		}

		let point = code

		if (code >= 0xd800 && code <= 0xdbff && (target.charCodeAt(k + 1) & 0xfc00) === 0xdc00) {
			point = ((code - 0xd800) << 10) + (target.charCodeAt(k + 1) - 0xdc00) + 0x10000
			k++
		} else if (code >= 0xd800 && code <= 0xdfff) return { refusal: "surrogate" }

		// UTF-8.
		if (point < 0x800) {
			byte(0xc0 | (point >> 6))
		} else if (point < 0x10000) {
			byte(0xe0 | (point >> 12))
			byte(0x80 | ((point >> 6) & 63))
		} else {
			byte(0xf0 | (point >> 18))
			byte(0x80 | ((point >> 12) & 63))
			byte(0x80 | ((point >> 6) & 63))
		}

		byte(0x80 | (point & 63))
	}

	return { uri: out }
}

export const parseInsertCommand: DocxCommandParser<InsertCommand> = (type, value) => {
	if (type === "insert.symbol") {
		const text = stringArg(value, "text", MAX_SYMBOL, 1)

		return text === undefined || !insertable(text) ? undefined : { type, text }
	}

	if (type !== "link.set") return { type } as InsertCommand

	const hasText = field(value, "text") !== undefined
	const text = stringArg(value, "text", MAX_LINK_TEXT, 1)

	if (hasText && (text === undefined || !insertable(text))) return undefined

	const extra = text === undefined ? {} : { text }
	const target = stringArg(value, "target", MAX_LINK_TARGET, 1)
	const anchor = field(value, "anchor")
	const heading = field(value, "heading")
	const given = [field(value, "target"), anchor, heading].filter(arg => arg !== undefined).length

	if (given !== 1) return undefined
	if (target !== undefined) {
		const written = hasControl(target) ? undefined : linkTargetUri(target)

		return written !== undefined && "uri" in written ? { type, target: written.uri, ...extra } : undefined
	}

	if (typeof anchor === "string" && BOOKMARK_NAME.test(anchor)) return { type, anchor, ...extra }

	const pos = intArg(value, "heading", 0, Number.MAX_SAFE_INTEGER)

	return pos === undefined ? undefined : { type, heading: pos, ...extra }
}
