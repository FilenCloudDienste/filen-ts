import type { EmailNames } from "@/features/preview/lib/emailReading"

// A message as plain text for a reader that takes text (the assistant): its headers, its text body (or its HTML's
// text), and its attachments' names; never a part's bytes. At most `limit` characters and one more, so a caller that
// clips at `limit` can tell it was cut.

// Elements whose content is never text a reader sees.
const SKIPPED: ReadonlySet<string> = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "math"])
// Elements that end a line.
const BREAKS: ReadonlySet<string> = new Set([
	"br",
	"p",
	"div",
	"li",
	"tr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"pre",
	"table",
	"ul",
	"ol",
	"hr",
	"section",
	"article",
	"header",
	"footer"
])
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
const TAG = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/

function decodeEntities(text: string): string {
	return text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]+);/gi, (reference, body: string) => {
		if (body.startsWith("#")) {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)

			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reference
		}

		return NAMED[body.toLowerCase()] ?? reference
	})
}

// Where the tag that starts before `from` ends: its first ">" outside a quoted attribute value; -1 for none.
function tagEnd(html: string, from: number): number {
	let quote = ""

	for (let at = from; at < html.length; at++) {
		const char = html[at]

		if (quote !== "") {
			if (char === quote) quote = ""
		} else if (char === '"' || char === "'") {
			quote = char
		} else if (char === ">") {
			return at
		}
	}

	return -1
}

// Inline data (a data: URI, a long base64-looking run) never reaches the reader: no tag scan is the only guard.
function withoutInlineData(text: string): string {
	return text.replace(/data:[^\s"'<>]+/gi, "[data]").replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "[data]")
}

// The text of an HTML body, read until `limit` characters: one pass of indexOf over the markup.
export function htmlText(html: string, limit: number): string {
	const lower = html.toLowerCase()
	const out: string[] = []
	// Its length, and whether it ends a line (white space aside): an element's start and end make one break, not two.
	const read = { length: 0, lineEnded: true }
	let at = 0

	const push = (text: string): void => {
		out.push(text)
		read.length += text.length

		if (/\S/.test(text)) read.lineEnded = false
	}

	while (at < html.length && read.length <= limit) {
		const open = html.indexOf("<", at)

		if (open < 0) {
			push(decodeEntities(html.slice(at)))
			break
		}

		push(decodeEntities(html.slice(at, open)))

		if (html.startsWith("<!--", open)) {
			const end = html.indexOf("-->", open + 4)

			at = end < 0 ? html.length : end + 3
			continue
		}

		// Not a tag ("a < b"): text.
		if (!/[a-zA-Z/!?]/.test(html[open + 1] ?? "")) {
			push("<")
			at = open + 1
			continue
		}

		const close = tagEnd(html, open + 1)

		if (close < 0) break

		const name = TAG.exec(html.slice(open, Math.min(close + 1, open + 64)))?.[1]?.toLowerCase()
		const closing = html[open + 1] === "/"

		at = close + 1

		if (name === undefined) continue

		if (!closing && SKIPPED.has(name)) {
			const end = lower.indexOf(`</${name}`, at)
			const after = end < 0 ? -1 : html.indexOf(">", end)

			at = after < 0 ? html.length : after + 1
			continue
		}

		if (BREAKS.has(name) && !read.lineEnded) {
			push("\n")
			read.lineEnded = true
		}
	}

	return out
		.join("")
		.replace(/[ \t\f\v\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

// The headers' share of the extract: lists past their share are cut and counted, so the body always has room.
const HEADER_CHARS = 1000
const FIELD_CHARS = 200
const LIST_CHARS = 300

// "a, b and 3 more": entries while they fit LIST_CHARS, the rest (and `uncounted` not read at all) counted.
function summary(values: readonly string[], uncounted: number): string {
	let shown = ""
	let count = 0

	for (const value of values) {
		const next = shown === "" ? value : `${shown}, ${value}`

		if (next.length > LIST_CHARS) break

		shown = next
		count++
	}

	const more = values.length - count + uncounted

	return more > 0 ? `${shown}${shown === "" ? "" : " and "}${String(more)} more` : shown
}

export function emailText(message: EmailNames, limit: number): string {
	const lines: string[] = []
	const field = (label: string, value: string | null): void => {
		if (value !== null && value !== "") lines.push(`${label}: ${value.slice(0, FIELD_CHARS)}`)
	}
	const list = (label: string, values: readonly string[], uncounted = 0): void => {
		if (values.length + uncounted > 0) lines.push(`${label}: ${summary(values, uncounted)}`)
	}

	field("From", message.from)
	field("Sender", message.sender)
	list("Reply-To", message.replyTo)
	list("To", message.to, message.addressesOmitted)
	list("Cc", message.cc)
	field("Date", message.date)
	field("Subject", message.subject)
	list(
		"Attachments",
		message.attachments.map(attachment => attachment.name)
	)

	const head = `${lines.join("\n").slice(0, HEADER_CHARS)}\n\n`
	const room = Math.max(0, limit + 1 - head.length)
	const text = message.text?.trim() ?? ""
	const body =
		text !== ""
			? text.slice(0, room)
			: message.html !== null
				? htmlText(message.html, room).slice(0, room)
				: message.htmlTooLarge
					? "(The message's HTML body is too large to read.)"
					: ""

	return withoutInlineData(`${head}${body}`).slice(0, limit + 1)
}
