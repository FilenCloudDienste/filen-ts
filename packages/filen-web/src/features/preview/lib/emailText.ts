import type { EmailMessage } from "@/features/preview/lib/emailReading"

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

		const close = html.indexOf(">", open + 1)

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

export function emailText(message: EmailMessage, limit: number): string {
	const lines: string[] = []
	const header = (label: string, value: string | null | readonly string[]): void => {
		const shown = typeof value === "string" ? value : value === null ? "" : value.join(", ")

		if (shown !== "") lines.push(`${label}: ${shown}`)
	}

	header("From", message.from)
	header("Reply-To", message.replyTo)
	header("To", message.to)
	header("Cc", message.cc)
	header("Date", message.date)
	header("Subject", message.subject)
	header(
		"Attachments",
		message.attachments.map(attachment => attachment.name)
	)

	const head = `${lines.join("\n")}\n\n`
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

	return `${head}${body}`.slice(0, limit + 1)
}
