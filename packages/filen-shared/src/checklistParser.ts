import { HTMLElement } from "node-html-better-parser"
import { v4 as uuidv4 } from "uuid"
import { decodeHtmlEntities } from "./htmlEntities"

export type ChecklistItem = {
	checked: boolean
	content: string
	id: string
}

export type Checklist = ChecklistItem[]

// Rows are read as node-html-better-parser reads the note, without running it. After a "<" that starts no tag
// ("count<limit fails on second try"), its markup regex tries every way of splitting the text that follows into
// attributes, which takes exponential time, and its tree queries recurse once per nesting level. walkMarkup finds
// exactly the markup the regex finds, in linear time, and readRows follows the parser's own rules to build the rows
// its tree holds.

const FAIL = -1

// The parser's tables, as object literals so that inherited keys ("constructor") read as they do there.
const HEADINGS = { p: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true }
const CELLS = { td: true, th: true }
const TABLE_ROWS = { tr: true, thead: true, tbody: true, tfoot: true }
const LISTS = { ul: true, ol: true }

// For each element, the opening tags that end it first
const CLOSED_BY_OPENING: Record<string, Record<string, unknown>> = {
	li: { li: true },
	p: HEADINGS,
	b: { div: true },
	td: CELLS,
	th: CELLS,
	h1: HEADINGS,
	h2: HEADINGS,
	h3: HEADINGS,
	h4: HEADINGS,
	h5: HEADINGS,
	h6: HEADINGS,
	colgroup: TABLE_ROWS,
	tr: TABLE_ROWS,
	thead: TABLE_ROWS,
	tbody: TABLE_ROWS,
	tfoot: TABLE_ROWS,
	ul: LISTS,
	ol: LISTS,
	aside: { aside: true },
	nav: { nav: true },
	form: { form: true },
	header: { header: true },
	footer: { footer: true },
	main: { main: true }
}

// Elements that end as they open, and whose close tags are ignored
const VOID_ELEMENTS: Record<string, unknown> = {
	area: true,
	base: true,
	br: true,
	col: true,
	hr: true,
	img: true,
	input: true,
	link: true,
	meta: true,
	source: true
}

// Elements whose content is skipped up to their close tag
const RAW_TEXT_ELEMENTS: Record<string, unknown> = {
	script: true,
	noscript: true,
	style: true,
	pre: true
}

// The parser's default options, empty: a raw text element keeps its content as text only when its name is found here,
// as an inherited key
const KEPT_RAW_TEXT: Record<string, unknown> = {}

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
	// Markup the parser reads from `start` to `end`: a tag named from `nameStart` to `nameEnd`, or a comment when
	// `nameStart` is FAIL
	markup: (start: number, nameStart: number, nameEnd: number, end: number) => boolean
	// The content of the raw text element just opened, from `start` to `end`, and where its close tag ends, FAIL when it
	// has none and the content runs to the end of the note
	rawText: (start: number, end: number, closeEnd: number) => boolean
}

// Walks the markup the parser reads, in order: what its regex matches, and the content of raw text elements, which the
// regex never reads. A callback returning true stops the walk.
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
			lt = html.indexOf("<", lt + 1)

			continue
		}

		if (visitor.markup(lt, nameStart, nameEnd, end)) {
			return
		}

		// The parser takes a raw text element's content up to its close tag, and all the rest when there is none.
		const opened = nameStart === FAIL || html.charCodeAt(nameStart - 1) === 47 ? "" : html.slice(nameStart, nameEnd)

		if (RAW_TEXT_ELEMENTS[opened]) {
			const close = new RegExp(`</${opened}\\s*>`, "ig")

			close.lastIndex = end

			const closed = close.exec(html)

			if (closed === null) {
				visitor.rawText(end, n, FAIL)

				return
			}

			if (visitor.rawText(end, closed.index, close.lastIndex)) {
				return
			}

			end = close.lastIndex
		}

		lt = html.indexOf("<", end)
	}
}

// Rows are escaped on write and decoded on read, so text with `<`, `>` or `&` survives the round trip.
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// A `ul`, which rows are read under.
type List = {
	// Where its tag's attributes lie, read for its checked state once a row is read under it
	attributesStart: number
	attributesEnd: number
	checked: boolean | undefined
	parent: List | undefined
	// The list at the top level it sits in, itself included. At the end the parser removes every list still open except
	// one at the top level, so that list is kept even if never closed.
	top: List | undefined
	closed: boolean
	// The rows opened inside it: rows[firstRow..endRow), endRow FAIL while open
	firstRow: number
	endRow: number
}

// An `li` inside a list. Still open at the end, it is removed and reads as no row.
type Row = {
	list: List
	parent: Row | undefined
	// All the text inside it, nested rows included: chunks[firstChunk..endChunk), which span textStart..textEnd of all
	// the row text read
	firstChunk: number
	endChunk: number
	textStart: number
	textEnd: number
	closed: boolean
}

type Frame = {
	name: string
	list: List | undefined
	row: Row | undefined
}

// Whether opening `name` inside `parent` ends `parent` first. Where the parser's lookup throws ("caller" inside
// "constructor"), the parser fails on the whole note; this ends nothing, and the rows read on.
function endsParent(parent: string, name: string): boolean {
	const ended = CLOSED_BY_OPENING[parent]

	if (!ended) {
		return false
	}

	try {
		return Boolean(ended[name])
	} catch {
		return false
	}
}

function isChecked(html: string, list: List): boolean {
	if (list.checked === undefined) {
		list.checked =
			new HTMLElement("ul", html.slice(list.attributesStart, list.attributesEnd).trim()).getAttribute("data-checked") === "true"
	}

	return list.checked
}

function isKept(list: List): boolean {
	return list.closed || list.top === list
}

// Older mobile builds stored rows unescaped, and the parser's own `.text` would also expand legacy names
// that lack the ";": "cut&copy" read as "cut©", "Issue&#42" as "Issue*".
function rowContent(chunks: string[], firstChunk: number, endChunk: number): string {
	return decodeHtmlEntities(endChunk - firstChunk === 1 ? (chunks[firstChunk] ?? "") : chunks.slice(firstChunk, endChunk).join("")).trim()
}

type NestedRows = {
	lists: List[]
	rows: Row[]
	chunks: string[]
	// The innermost row open as each chunk was read
	owners: Row[]
	noteLength: number
	// How many rows were visited already, which lead in either reading
	visited: number
	visit: (list: List, content: string) => boolean
}

// The parser reads every row inside a list, nested ones included, once under each list around it, and a row's text
// includes the rows nested in it, so each level of nesting repeats rows and text. That reading is kept while it holds
// at most four times the rows read once and four times the note's length in text. Past that, each row is read once,
// under its nearest list, without the rows nested in it.
function readNestedRows({ lists, rows, chunks, owners, noteLength, visited, visit }: NestedRows): void {
	let once = 0

	for (const row of rows) {
		if (row.closed && (isKept(row.list) || row.list.top !== undefined)) {
			once++
		}
	}

	let pairs = 0
	let length = 0

	for (const list of lists) {
		if (!isKept(list)) {
			continue
		}

		for (let i = list.firstRow, end = list.endRow === FAIL ? rows.length : list.endRow; i < end; i++) {
			const row = rows[i]

			if (row !== undefined && row.closed) {
				pairs++
				length += row.textEnd - row.textStart
			}
		}

		if (pairs > once * 4 || length > noteLength * 4) {
			break
		}
	}

	let index = 0

	if (pairs <= once * 4 && length <= noteLength * 4) {
		for (const list of lists) {
			if (!isKept(list)) {
				continue
			}

			for (let i = list.firstRow, end = list.endRow === FAIL ? rows.length : list.endRow; i < end; i++) {
				const row = rows[i]

				if (row === undefined || !row.closed || index++ < visited) {
					continue
				}

				if (visit(list, rowContent(chunks, row.firstChunk, row.endChunk))) {
					return
				}
			}
		}

		return
	}

	const own = new Map<Row, string[]>()

	for (let i = 0; i < chunks.length; i++) {
		const owner = owners[i]
		const chunk = chunks[i]

		if (owner === undefined || chunk === undefined) {
			continue
		}

		const parts = own.get(owner)

		if (parts === undefined) {
			own.set(owner, [chunk])
		} else {
			parts.push(chunk)
		}
	}

	for (const row of rows) {
		// An open list other than the top-level one is removed at the end, leaving its rows in the list around it
		const list = isKept(row.list) ? row.list : row.list.top

		if (!row.closed || list === undefined || index++ < visited) {
			continue
		}

		const parts = own.get(row)

		if (visit(list, rowContent(parts ?? [], 0, parts?.length ?? 0))) {
			return
		}
	}
}

// Visits the rows the parser's tree holds, in the order the parser reads them: each list in turn, every row inside it,
// with all the text inside that row. `visit` returning true stops the walk.
function readRows(html: string, visit: (list: List, content: string) => boolean): void {
	const frames: Frame[] = []
	const lists: List[] = []
	const rows: Row[] = []
	const chunks: string[] = []
	const owners: Row[] = []
	let list: List | undefined
	let row: Row | undefined
	let text = 0
	let textLength = 0
	let rawName = ""
	let rawSelfClosing = false
	// While each row sits alone in a list at the top level, nothing after it changes how it reads, so it is visited as
	// it closes. Once one does not, the rest is visited at the end.
	let streaming = true
	let visited = 0
	let stopped = false

	function addText(start: number, end: number): void {
		if (row === undefined || end <= start) {
			return
		}

		const chunk = html.slice(start, end)

		chunks.push(chunk)
		owners.push(row)

		textLength += chunk.length
	}

	function open(name: string, attributesStart: number, attributesEnd: number): void {
		let openedList: List | undefined
		let openedRow: Row | undefined

		if (name === "ul") {
			openedList = {
				attributesStart,
				attributesEnd,
				checked: undefined,
				parent: list,
				top: list?.top,
				closed: false,
				firstRow: rows.length,
				endRow: FAIL
			}

			if (list === undefined && frames.length === 0) {
				openedList.top = openedList
			}

			lists.push(openedList)

			list = openedList
		} else if (name === "li" && list !== undefined) {
			if (row !== undefined || list.top !== list) {
				streaming = false
			}

			openedRow = {
				list,
				parent: row,
				firstChunk: chunks.length,
				endChunk: chunks.length,
				textStart: textLength,
				textEnd: textLength,
				closed: false
			}

			rows.push(openedRow)

			row = openedRow
		}

		frames.push({
			name,
			list: openedList,
			row: openedRow
		})
	}

	function pop(): void {
		const frame = frames.pop()
		const closedRow = frame?.row
		const closedList = frame?.list

		if (closedRow !== undefined) {
			closedRow.endChunk = chunks.length
			closedRow.textEnd = textLength
			closedRow.closed = true

			row = closedRow.parent

			if (streaming && !stopped) {
				visited++

				stopped = visit(closedRow.list, rowContent(chunks, closedRow.firstChunk, closedRow.endChunk))
			}
		}

		if (closedList !== undefined) {
			closedList.endRow = rows.length
			closedList.closed = true

			list = closedList.parent
		}
	}

	// Pops up to and including the innermost `name`, or everything when none is open, as the parser's close tag does
	function close(name: string): void {
		for (let top = frames[frames.length - 1]; top !== undefined; top = frames[frames.length - 1]) {
			pop()

			if (top.name === name) {
				return
			}
		}
	}

	walkMarkup(html, {
		markup: (start, nameStart, nameEnd, end) => {
			addText(text, start)

			text = end

			if (nameStart === FAIL) {
				return false
			}

			const name = html.slice(nameStart, nameEnd)

			if (html.charCodeAt(nameStart - 1) === 47) {
				// The close tag of an element that takes none is ignored
				if (!VOID_ELEMENTS[name]) {
					close(name)
				}

				return stopped
			}

			const selfClosing = html.charCodeAt(end - 2) === 47
			const parent = frames[frames.length - 1]

			if (!selfClosing && parent !== undefined && endsParent(parent.name, name)) {
				pop()
			}

			open(name, nameEnd, end - (selfClosing ? 2 : 1))

			if (RAW_TEXT_ELEMENTS[name]) {
				rawName = name
				rawSelfClosing = selfClosing
			} else if (selfClosing || VOID_ELEMENTS[name]) {
				close(name)
			}

			return stopped
		},
		rawText: (start, end, closeEnd) => {
			if (KEPT_RAW_TEXT[rawName]) {
				addText(start, end)
			}

			// Its close tag ends it, except a void one's, which the parser ignores. Without a close tag, it ends only
			// when it closes itself or is void.
			if (closeEnd === FAIL ? rawSelfClosing || VOID_ELEMENTS[rawName] : !VOID_ELEMENTS[rawName]) {
				close(rawName)
			}

			text = closeEnd

			return stopped
		}
	})

	// Text after the last markup goes to the top level, outside every row, so it is never read.
	if (stopped || streaming) {
		return
	}

	readNestedRows({
		lists,
		rows,
		chunks,
		owners,
		noteLength: html.length,
		visited,
		visit
	})
}

export class ChecklistParser {
	public parse(html: string): Checklist {
		try {
			const checklist: Checklist = []

			readRows(html, (list, content) => {
				checklist.push({
					checked: isChecked(html, list),
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

	// The first row with text that parse reads, "" when there is none. Previews are made for every saved or received
	// edit, so rows that do not nest are read only up to that one, and no ids are made.
	public firstNonEmptyContent(html: string): string {
		let first = ""

		readRows(html, (_list, content) => {
			if (content.length === 0) {
				return false
			}

			first = content

			return true
		})

		return first
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
