import { HTMLElement, parse } from "node-html-better-parser"
import { v4 as uuidv4 } from "uuid"
import { decodeHtmlEntities } from "./htmlEntities"

export type ChecklistItem = {
	checked: boolean
	content: string
	id: string
}

export type Checklist = ChecklistItem[]

// node-html-better-parser finds markup with one regex. After a "<" that starts no tag ("count<limit fails on second
// try"), that regex tries every way of splitting the text that follows into attributes before giving up, which takes
// exponential time. walkMarkup finds exactly the markup the regex finds in linear time, so the parser is only handed
// markup it reads in one pass and rows read as they always have.

const FAIL = -1

// The parser's table of elements whose content it skips, read the same way, so inherited keys ("constructor") count.
const RAW_TEXT_ELEMENTS: Record<string, unknown> = {
	script: true,
	noscript: true,
	style: true,
	pre: true
}

// JavaScript's `\s`.
function isSpace(c: number): boolean {
	return (
		c === 32 ||
		(c >= 9 && c <= 13) ||
		c === 160 ||
		c === 5760 ||
		(c >= 8192 && c <= 8202) ||
		c === 8232 ||
		c === 8233 ||
		c === 8239 ||
		c === 8287 ||
		c === 12288 ||
		c === 65279
	)
}

function isLetter(c: number): boolean {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

// `[-.:0-9_a-z]` in any case: the rest of a tag or attribute name.
function isNameChar(c: number): boolean {
	return isLetter(c) || (c >= 45 && c <= 58 && c !== 47) || c === 95
}

// `[^<\/>\s]`: a character of an attribute without a value.
function isTokenChar(c: number): boolean {
	return c !== 60 && c !== 47 && c !== 62 && !isSpace(c)
}

// `\/(?!>)|[^\s"'<>/]`: a character of an unquoted value. `i` must be inside `html`.
function isValueChar(html: string, i: number): boolean {
	const c = html.charCodeAt(i)

	return c === 47 ? html.charCodeAt(i + 1) !== 62 : c !== 34 && c !== 39 && isTokenChar(c)
}

function first(end: number, otherwise: number): number {
	return end !== FAIL ? end : otherwise
}

// Where the value after an attribute name ending at `p` starts, past `\s*=\s*`; FAIL without an "=".
function valueStart(html: string, p: number): number {
	const n = html.length

	while (p < n && isSpace(html.charCodeAt(p))) {
		p++
	}

	if (html.charCodeAt(p) !== 61) {
		return FAIL
	}

	do {
		p++
	} while (p < n && isSpace(html.charCodeAt(p)))

	return p
}

// Past the ">" of a tag whose attributes start at `p`, each read as the regex tries first: the longest name with its
// value when one follows, else the longest run of attribute characters. FAIL when that meets no ">", which is where
// the regex starts backtracking.
function firstReadingEnd(html: string, p: number): number {
	const n = html.length

	for (;;) {
		while (p < n && isSpace(html.charCodeAt(p))) {
			p++
		}

		const c = html.charCodeAt(p)

		if (c === 62) {
			return p + 1
		}

		if (c === 47) {
			return html.charCodeAt(p + 1) === 62 ? p + 2 : FAIL
		}

		if (p === n || c === 60) {
			return FAIL
		}

		p++

		if (!isLetter(c)) {
			while (p < n && isTokenChar(html.charCodeAt(p))) {
				p++
			}

			continue
		}

		while (p < n && isNameChar(html.charCodeAt(p))) {
			p++
		}

		const value = valueStart(html, p)

		if (value === FAIL) {
			continue
		}

		const quote = html.charCodeAt(value)

		if (quote === 34 || quote === 39) {
			const close = html.indexOf(quote === 34 ? "\"" : "'", value + 1)

			if (close !== FAIL) {
				p = close + 1
			}

			continue
		}

		let end = value

		while (end < n && isValueChar(html, end)) {
			end++
		}

		if (end > value) {
			p = end
		}
	}
}

// Past the ">" of a tag whose attributes start at each position from `lo`, or FAIL: the first reading the regex
// reaches, backtracking included. The regex reads the text after a position again for every way of splitting the text
// before it; filled from the end, each position is read once.
function tagEnds(html: string, lo: number): Int32Array {
	const n = html.length
	const ends = new Int32Array(n - lo + 1)
	// The first end among the positions after this one to the end of its run of attribute, name or unquoted value
	// characters, farthest first: the order in which the regex tries shorter attributes, names and values.
	let token = FAIL
	let name = FAIL
	let value = FAIL
	// The end past the "=" and value that follow the current run of name characters
	let assigned = FAIL
	// Where the last unquoted value right after an "=" starts, and its `value`
	let valueAt = FAIL
	let valueFirst = FAIL
	let nextIsToken = false
	let nextIsName = false
	let nextIsValue = false

	ends[n - lo] = FAIL

	for (let p = n - 1; p >= lo; p--) {
		const c = html.charCodeAt(p)
		const next = ends[p + 1 - lo] ?? FAIL
		const isToken = isTokenChar(c)
		const isName = isNameChar(c)
		const isValue = isValueChar(html, p)

		if (isToken) {
			token = nextIsToken ? first(token, next) : next
		}

		if (isName && nextIsName) {
			name = first(name, next)
		} else if (isName) {
			name = next

			const start = valueStart(html, p + 1)
			const quote = start === FAIL ? FAIL : html.charCodeAt(start)

			if (quote === 34 || quote === 39) {
				const close = html.indexOf(quote === 34 ? "\"" : "'", start + 1)

				assigned = close === FAIL ? FAIL : (ends[close + 1 - lo] ?? FAIL)
			} else {
				// Only whitespace and the "=" lie between, so a value there is still the last one recorded: this
				// position, which may follow an "=" itself, is recorded only below
				assigned = start !== FAIL && start === valueAt ? valueFirst : FAIL
			}
		}

		if (isValue) {
			value = nextIsValue ? first(value, next) : next

			let before = p - 1

			while (before >= 0 && isSpace(html.charCodeAt(before))) {
				before--
			}

			if (html.charCodeAt(before) === 61) {
				valueAt = p
				valueFirst = value
			}
		}

		nextIsToken = isToken
		nextIsName = isName
		nextIsValue = isValue

		if (c === 60) {
			ends[p - lo] = FAIL
		} else if (c === 62) {
			ends[p - lo] = p + 1
		} else if (c === 47) {
			ends[p - lo] = html.charCodeAt(p + 1) === 62 ? p + 2 : FAIL
		} else if (!isToken) {
			// Whitespace
			ends[p - lo] = next
		} else {
			ends[p - lo] = first(isLetter(c) ? first(assigned, name) : FAIL, token)
		}
	}

	return ends
}

type MarkupVisitor = {
	// A "<" the parser keeps as text
	text?: (at: number) => void
	// Markup the parser reads from `start` to `end`: a tag named from `nameStart` to `nameEnd`, or a comment when
	// `nameStart` is FAIL. `verbatim` when the regex reads it in one pass as written. Returning true stops the walk.
	markup: (start: number, nameStart: number, nameEnd: number, end: number, verbatim: boolean) => boolean
}

// Walks the markup the parser reads, in order: what its regex matches and what it skips of raw text elements.
function walkMarkup(html: string, visitor: MarkupVisitor): void {
	const n = html.length
	// Every reading from the first "<" where the regex would backtrack on
	let ends: Int32Array | undefined
	let lo = 0
	let commentClose = -2
	let lt = html.indexOf("<")

	while (lt !== -1) {
		let nameStart = FAIL
		let nameEnd = FAIL
		let end = FAIL

		if (html.startsWith("<!--", lt)) {
			if (commentClose !== FAIL && commentClose < lt + 4) {
				commentClose = html.indexOf("-->", lt + 4)
			}

			end = commentClose === FAIL ? FAIL : commentClose + 3
		} else {
			nameStart = html.charCodeAt(lt + 1) === 47 ? lt + 2 : lt + 1

			if (isLetter(html.charCodeAt(nameStart))) {
				nameEnd = nameStart + 1

				while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd))) {
					nameEnd++
				}

				if (ends === undefined) {
					end = firstReadingEnd(html, nameEnd)
				}

				if (end === FAIL) {
					if (ends === undefined) {
						lo = lt
						ends = tagEnds(html, lo)
					}

					// Backtracking, the regex tries every shorter name after the longest
					for (; nameEnd > nameStart; nameEnd--) {
						end = ends[nameEnd - lo] ?? FAIL

						if (end !== FAIL) {
							break
						}
					}
				}
			}
		}

		if (end === FAIL) {
			visitor.text?.(lt)
			lt = html.indexOf("<", lt + 1)

			continue
		}

		const verbatim = nameStart === FAIL || ends === undefined

		if (visitor.markup(lt, nameStart, nameEnd, end, verbatim)) {
			return
		}

		// The parser skips a raw text element's content up to its close tag, and all the rest when there is none.
		const opened = nameStart === FAIL || html.charCodeAt(nameStart - 1) === 47 ? "" : html.slice(nameStart, nameEnd)

		if (RAW_TEXT_ELEMENTS[opened]) {
			const close = new RegExp(`</${opened}\\s*>`, "ig")

			close.lastIndex = end

			const closed = close.exec(html)

			if (closed === null || visitor.markup(end, closed.index + 2, closed.index + 2 + opened.length, close.lastIndex, verbatim)) {
				return
			}

			end = close.lastIndex
		}

		lt = html.indexOf("<", end)
	}
}

// A tag the parser reads, reduced to its name and, on a list, its checked state. It adds no quote: a tag kept as
// written may end where it does only because its opening quote is never closed.
function bareTag(html: string, nameStart: number, nameEnd: number, end: number): string {
	const name = html.slice(nameStart, nameEnd)
	const closing = html.charCodeAt(nameStart - 1) === 47
	const selfClosing = html.charCodeAt(end - 2) === 47
	const checked =
		!closing &&
		name === "ul" &&
		new HTMLElement(name, html.slice(nameEnd, end - (selfClosing ? 2 : 1)).trim()).getAttribute("data-checked") === "true"

	return `<${closing ? "/" : ""}${name}${checked ? " data-checked=true" : ""}${selfClosing ? "/" : ""}>`
}

// `html` changed only where the parser's regex would backtrack: a "<" it keeps as text is escaped, which rowContent
// decodes back, and a tag it reaches by backtracking is reduced to what the rows read of it.
function readableMarkup(html: string): string {
	const parts: string[] = []
	let copied = 0

	walkMarkup(html, {
		text: at => {
			parts.push(html.slice(copied, at), "&lt;")
			copied = at + 1
		},
		markup: (start, nameStart, nameEnd, end, verbatim) => {
			if (!verbatim) {
				parts.push(html.slice(copied, start), bareTag(html, nameStart, nameEnd, end))
				copied = end
			}

			return false
		}
	})

	if (copied === 0) {
		return html
	}

	parts.push(html.slice(copied))

	return parts.join("")
}

// Rows are escaped on write and decoded on read, so text with `<`, `>` or `&` survives the round trip.
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Older mobile builds stored rows unescaped, and the parser's own `.text` would also expand legacy names
// that lack the ";": "cut&copy" read as "cut©", "Issue&#42" as "Issue*".
function rowContent(li: HTMLElement): string {
	return decodeHtmlEntities(li.rawText).trim()
}

// Visits every row in document order; `visit` returning true stops the walk.
function walkRows(html: string, visit: (checked: boolean, content: string) => boolean): void {
	for (const ul of parse(readableMarkup(html)).querySelectorAll("ul")) {
		const checked = ul.getAttribute("data-checked") === "true"

		for (const li of ul.querySelectorAll("li")) {
			if (visit(checked, rowContent(li))) {
				return
			}
		}
	}
}

export class ChecklistParser {
	public parse(html: string): Checklist {
		try {
			const checklist: Checklist = []

			walkRows(html, (checked, content) => {
				checklist.push({
					checked,
					content,
					id: uuidv4()
				})

				return false
			})

			return checklist
		} catch {
			return []
		}
	}

	// The first row with text, "" when there is none, taking rows as parse does in well-formed lists: each `li`
	// of a `ul`, ended by the next row or list tag and dropped if still open at the end. Previews are made for
	// every saved or received edit, so this reads only up to that row and builds no document.
	public firstNonEmptyContent(html: string): string {
		const row: string[] = []
		let inRow = false
		let inList = false
		let text = 0
		let content = ""

		walkMarkup(html, {
			markup: (start, nameStart, nameEnd, end) => {
				if (inRow) {
					row.push(html.slice(text, start))
				}

				text = end

				const name = nameStart === FAIL ? "" : html.slice(nameStart, nameEnd)
				const opening = html.charCodeAt(nameStart - 1) !== 47

				// "<li/>" or "<ul/>" is an empty element of its own and changes no row or list.
				if ((name !== "li" && name !== "ul" && name !== "ol") || (opening && html.charCodeAt(end - 2) === 47)) {
					return false
				}

				if (inRow) {
					content = decodeHtmlEntities(row.join("")).trim()

					if (content.length > 0) {
						return true
					}

					row.length = 0
				}

				if (name !== "li") {
					inList = opening && name === "ul"
				}

				inRow = opening && name === "li" && inList

				return false
			}
		})

		return content
	}

	public stringify(checklist: Checklist): string {
		if (checklist.length === 0) {
			return ""
		}

		let html = ""
		let currentCheckedStatus: boolean | null = null

		for (const item of checklist) {
			if (currentCheckedStatus !== item.checked) {
				if (currentCheckedStatus !== null) {
					html += "</ul>"
				}

				html += `<ul data-checked="${item.checked}">`

				currentCheckedStatus = item.checked
			}

			const trimmed = escapeHtml(item.content.trim())

			html += `<li>${trimmed.length > 0 ? trimmed : "<br>"}</li>`
		}

		if (checklist.length > 0) {
			html += "</ul>"
		}

		return html
	}
}

export const checklistParser = new ChecklistParser()

export default checklistParser
