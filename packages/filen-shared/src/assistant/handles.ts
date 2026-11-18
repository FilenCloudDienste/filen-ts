import { escapeRegExp } from "./internal"
import { isAppResultKey } from "./untrusted"

// Handles ("f3", "c12") in replies. The model copies them from tool results into what it writes ("CV.pdf
// (f3)", "- f3: CV.pdf", "(handle: f3)"), where they mean nothing to the user, who knows items by name. A
// later turn, though, sees only the user's messages and the replies, and can act on an item without looking
// it up again only by a handle it reads there.

// A handle: a lowercase letter and a number, not inside a word, a file name ("d2.txt") or a path.
const HANDLE = String.raw`(?<![\p{L}\p{N}_./\\@#-])[a-z]\d{1,6}(?![\p{L}\p{N}_]|[./\\@-][\p{L}\p{N}])`

// Markdown a model wraps a handle in.
const WRAP = String.raw`(?:\*\*|\*|__|\x60)?`

// The handle, its markdown and a "handle:" label before it.
const TOKEN = new RegExp(String.raw`(\b[Hh]andle\s*[:：=]?\s*)?(${WRAP})(${HANDLE})(${WRAP})`, "gu")

// A markdown link whose target is only a handle, with or without a scheme: "[CV.pdf](f3)", "[CV.pdf](file://f3)".
const HANDLE_LINK = /\[([^\]\n]+)\]\(\s*(?:[a-z][\w+.-]*:\/\/)?([a-z]\d{1,6})\s*\)/gu

// Between a list label and the name it labels: "f3: CV.pdf", "f3 - CV.pdf", "f3 CV.pdf".
const LABEL_GAP = /^\s*(?:[:：.=]|[-–—](?=\s))?\s*/u

// What may stand around a name: quotes and markdown.
const QUOTES = String.raw`["'«»“”„‚‘’「」『』《》*_\x60]*`

// Inside brackets: the text since the bracket opened, and up to where it closes.
const IN_BRACKET_BEFORE = /[(（[]([^()（）[\]\n]*)$/u
const IN_BRACKET_AFTER = /^[^()（）[\]\n]*[)）\]]/u

// Where a list row starts: "- ", "1. ", "* ".
const ROW_START = /(?:^|\n)[ \t]*(?:[-*•+]|\d{1,3}[.)])?[ \t]*$/u

// LABEL_GAP within one line.
const ROW_LABEL_GAP = /^[ \t]*(?:[:：.=]|[-–—](?=[ \t]))?[ \t]*/u

// A list row: its marker, then what it lists.
const ROW = /^[ \t]*(?:[-*•+]|\d{1,3}[.)])[ \t]+(.*)$/u

// What a row holds besides made-up handles when it lists nothing: brackets, markdown, punctuation and
// bracketed placeholders ("- [file] (f1)").
const EMPTY_ROW = /^(?:[\s()（）*_\x60:：,;.-]|\[[^\]\n]*\])*$/u

// Marks a dropped handle until the brackets and separators around it are tidied.
const DROPPED = "\uE000"

const TIDY: readonly (readonly [RegExp, string])[] = [
	// "CV.pdf (f3)", "(handle: f3, f4)": brackets left with nothing in them go, with the space before them.
	[/[ \t]*[(（[][\s,;、，\uE000]*\uE000[\s,;、，\uE000]*[)）\]]/gu, ""],
	// "(file, handle f3)"
	[/\s*[,;、，]\s*\uE000/gu, ""],
	// "(handle: f3, shared)"
	[/\uE000\s*[,;、，]\s*/gu, ""],
	[/[ \t]*\uE000/gu, ""]
]

function usable(name: string | undefined): string | undefined {
	const value = name?.replace(/\s+/g, " ").trim()

	return value === undefined || Array.from(value).length < 2 ? undefined : value
}

// Text that ends with the item's name, give or take quotes, markdown and a colon.
function endsWithName(text: string, name: string): boolean {
	return new RegExp(String.raw`(?<![\p{L}\p{N}_])${escapeRegExp(name)}${QUOTES}\s*[:：]?\s*$`, "iu").test(text)
}

// The reply as the user sees it, with the handles of the items `name` knows (those the app gave out and the
// model saw) taken out of the places a handle stands as a reference: next to its item's name it goes ("CV.pdf
// (f3)", "- f3: CV.pdf", "(handle: f3)"); bracketed, labelled, as a list row's label, in markdown or as a
// link target it becomes the name. A handle in running prose stays: there a letter and a number are as
// likely a room, a priority or a key ("c12", "p1", "F1") as a reference. So does a `foreign` token, one the
// user typed or content read this turn holds, unless its item's name stands right beside it. An `invented`
// token, one no result gave out, names nothing: where a handle stands as a reference it goes, and a list row
// it alone filled goes with it.
export function replyWithoutHandles(
	reply: string,
	name: (handle: string) => string | undefined,
	{ foreign = new Set<string>(), invented = () => false }: { foreign?: ReadonlySet<string>; invented?: (handle: string) => boolean } = {}
): string {
	const madeUp = (handle: string) => !foreign.has(handle) && usable(name(handle)) === undefined && invented(handle)
	const text = reply
		.replace(HANDLE_LINK, (whole, label: string, handle: string) =>
			foreign.has(handle) || (usable(name(handle)) === undefined && !madeUp(handle)) ? whole : label
		)
		.split("\n")
		.filter(line => {
			const row = ROW.exec(line)

			if (row === null) {
				return true
			}

			let dropped = false
			const rest = (row[1] ?? "").replace(TOKEN, (whole, _label, _open, handle: string) => {
				if (!madeUp(handle)) {
					return whole
				}

				dropped = true

				return ""
			})

			return !dropped || !EMPTY_ROW.test(rest)
		})
		.join("\n")
	let shown = ""
	let cursor = 0

	for (const match of text.matchAll(TOKEN)) {
		const [whole, label, open = "", handle = "", close = ""] = match
		const start = match.index

		if (start < cursor) {
			continue
		}

		const item = usable(name(handle))
		const end = start + whole.length
		const before = shown + text.slice(cursor, start)
		const after = text.slice(end)
		const inBracket = IN_BRACKET_BEFORE.exec(before)
		const enclosed = inBracket !== null && IN_BRACKET_AFTER.test(after)
		const reference = enclosed || label !== undefined || (open !== "" && open === close) || ROW_START.test(before)

		if (item === undefined) {
			if (reference && madeUp(handle)) {
				if (ROW_START.test(before)) {
					// "- f1: 2 MB" keeps "- 2 MB".
					shown = before
					cursor = end + (ROW_LABEL_GAP.exec(after)?.[0].length ?? 0)
				} else {
					shown = before + DROPPED
					cursor = end
				}
			}

			continue
		}

		const named = escapeRegExp(item)
		const wrapped = open === close ? `${open}${item}${close}` : item
		const gap = LABEL_GAP.exec(after)?.[0] ?? ""
		const bracketed = new RegExp(String.raw`^\s*[(（]${QUOTES}${named}${QUOTES}[)）]`, "iu").exec(after)
		const described = new RegExp(String.raw`^\s*([(（][^()（）\n]{1,24}[)）])\s*[:：]?\s*(${QUOTES}${named}${QUOTES})`, "iu").exec(
			after
		)
		// The name before the handle, or before the brackets it stands in.
		const nameBefore = endsWithName(inBracket !== null && enclosed ? before.slice(0, inBracket.index) : before, item)
		let replacement: string | null = null

		if (new RegExp(String.raw`^${QUOTES}${named}`, "iu").test(after.slice(gap.length))) {
			// "- f3: CV.pdf", "**f3** `CV.pdf`": the label goes.
			replacement = ""
			cursor = end + gap.length
		} else if (described !== null) {
			// "- `d3` (directory): Photos": the name, then what it is.
			replacement = `${described[2] ?? ""} ${described[1] ?? ""}`
			cursor = end + described[0].length
		} else if (bracketed !== null) {
			// "**c3** (Carlos Ruiz)": the name, once.
			replacement = wrapped
			cursor = end + bracketed[0].length
		} else if (nameBefore) {
			// "CV.pdf (f3)", "CV.pdf (file, handle f3)", "CV.pdf f3"
			replacement = DROPPED
			cursor = end
		} else if (reference && !foreign.has(handle)) {
			// "the files (f5, f6)", "is **n11**", "- f3: 2 MB"
			replacement = wrapped
			cursor = end
		}

		if (replacement !== null) {
			shown = before + replacement
		}
	}

	return TIDY.reduce((tidied, [pattern, by]) => tidied.replace(pattern, by), shown + text.slice(cursor))
}

// A reply as it streams: without a handle, or a link to one, still being written, which could read as
// another, shorter one ("f1" of "f12") until its next character arrives.
export function settledReply(partial: string): string {
	return partial.replace(
		/(?:[ \t]*[(（[]\s*)?(?:\b[Hh]andle\s*[:：=]?\s*)?[*_\x60]*(?<![\p{L}\p{N}_./\\@#-])[a-z]\d*$|\[[^\]\n]*\]\([^)\n]*$/u,
		""
	)
}

// The handles a reply shows.
export function replyHandles(reply: string): string[] {
	return Array.from(reply.matchAll(new RegExp(HANDLE, "gu")), match => match[0])
}

// Handle-like tokens in what other people wrote: the strings a tool result carries outside the app's own
// fields. A string that is only a token is the app pointing at an item ("chat": "c1"), unless it is a name.
export function foreignTokens(value: unknown, into: Set<string>, key?: string): Set<string> {
	if (typeof value === "string") {
		if (key === undefined || !isAppResultKey(key)) {
			const tokens = replyHandles(value)
			const pointer = tokens.length === 1 && tokens[0] === value.trim() && key !== "name" && key !== "title"

			if (!pointer) {
				for (const token of tokens) {
					into.add(token)
				}
			}
		}
	} else if (Array.isArray(value)) {
		for (const item of value) {
			foreignTokens(item, into)
		}
	} else if (typeof value === "object" && value !== null) {
		for (const [entryKey, entry] of Object.entries(value)) {
			foreignTokens(entry, into, entryKey)
		}
	}

	return into
}

// At most this many items get their handle in the reply later turns read: a listing names dozens, and each
// costs prompt tokens on every later turn. The first ones named are what a follow-up most often points at.
const HISTORY_HANDLES_MAX = 8

// A name that is only a lowercase word ("notes", "to") is as likely the word as the item.
const PLAIN_WORD = /^\p{Ll}+$/u

// The reply as later turns read it: items this turn handed out whose names the reply repeats get their handle
// after the first mention, unless the reply shows the handle already. Names match whole and with their case;
// a longer name ("Project.docx") claims its text before a shorter one ("Project") can. Adds no text but handles.
export function replyWithHandles(reply: string, items: ReadonlyMap<string, string>): string {
	const present = new Set(replyHandles(reply))
	const claimed: { start: number; end: number; handle: string }[] = []
	const named = [...items]
		.flatMap(([handle, rawName]) => {
			const item = usable(rawName)

			return item === undefined || PLAIN_WORD.test(item) || present.has(handle) ? [] : [{ handle, item }]
		})
		.sort((a, b) => Array.from(b.item).length - Array.from(a.item).length)

	for (const { handle, item } of named) {
		const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}_])${escapeRegExp(item)}(?![\p{L}\p{N}_]|[./\\@-][\p{L}\p{N}])${QUOTES}`, "gu")

		for (const match of reply.matchAll(pattern)) {
			const start = match.index
			const end = start + match[0].length

			if (!claimed.some(span => start < span.end && end > span.start)) {
				claimed.push({ start, end, handle })

				break
			}
		}
	}

	return claimed
		.sort((a, b) => a.start - b.start)
		.slice(0, HISTORY_HANDLES_MAX)
		.sort((a, b) => b.end - a.end)
		.reduce((text, { end, handle }) => `${text.slice(0, end)} (${handle})${text.slice(end)}`, reply)
}
