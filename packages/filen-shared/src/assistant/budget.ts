import { isRecord } from "./internal"
import { isAppResultKey, isSpotlightSpan, spotlightText } from "./untrusted"

const UPPER = 0
const LOWER = 1
const DIGIT = 2
const SPACE = 3
const BREAK = 4
const PUNCT = 5
const OTHER = 6

function charClass(code: number): number {
	if (code >= 0x80) {
		return OTHER
	}

	if (code >= 0x41 && code <= 0x5a) {
		return UPPER
	}

	if (code >= 0x61 && code <= 0x7a) {
		return LOWER
	}

	if (code >= 0x30 && code <= 0x39) {
		return DIGIT
	}

	if (code === 0x20) {
		return SPACE
	}

	return code === 0x09 || code === 0x0a || code === 0x0d ? BREAK : code < 0x20 ? OTHER : PUNCT
}

// The engines expose no tokenizer, so prompt size is estimated from characters against what Qwen's vocabulary
// (Qwen3.5, measured) makes of a rendered prompt: a digit is a token, a run of ASCII punctuation one per two
// marks (what listings, dates, sizes and CSV are made of), an ASCII word one per five letters (per three in
// capitals) with the space before it nearly free, a run of line breaks or of spaces one. Mixed case (base64,
// keys, identifiers) splits into short runs. Any other character counts as a token (CJK, Cyrillic, Arabic or
// Devanagari text takes two to four), the spotlight delimiters as two and characters outside the basic plane
// (emoji) as four. Prose comes out about a third high, which only drops history a little early. Letters
// that form no words come out low: base64 and random keys by up to a third, long runs of random small letters
// by half or more; nothing short of the tokenizer tells them from words.
export function estimateTokens(text: string): number {
	let tokens = 0
	let index = 0

	while (index < text.length) {
		const code = text.codePointAt(index) ?? 0
		const kind = charClass(code)
		let end = index + 1

		if (kind === UPPER || kind === LOWER) {
			let upper = kind === UPPER

			while (end < text.length) {
				const next = charClass(text.charCodeAt(end))
				const previous = charClass(text.charCodeAt(end - 1))

				// A run ends where a capital follows a small letter, and before the last of several capitals a small
				// letter follows ("XMLHttp" is "XML" "Http").
				if ((next !== UPPER && next !== LOWER) || (previous === LOWER && next === UPPER)) {
					break
				}

				if (next === LOWER && upper && end - index > 1) {
					end--
					break
				}

				upper &&= next === UPPER
				end++
			}

			const length = end - index

			tokens += Math.ceil(length / (upper && length > 1 ? 3 : 5))
		} else if (kind === SPACE) {
			while (end < text.length && text.charCodeAt(end) === 0x20) {
				end++
			}

			const next = end < text.length ? charClass(text.charCodeAt(end)) : PUNCT
			const word = next === UPPER || next === LOWER || next === OTHER

			tokens += end - index === 1 && word ? 0.25 : 1
		} else if (kind === BREAK || kind === PUNCT) {
			while (end < text.length && charClass(text.charCodeAt(end)) === kind) {
				end++
			}

			tokens += kind === BREAK ? 1 : Math.ceil((end - index) / 2)
		} else if (kind === DIGIT) {
			tokens += 1
		} else if (code > 0xffff) {
			tokens += 4
			end = index + 2
		} else {
			tokens += code === 0x27e6 || code === 0x27e7 ? 2 : 1
		}

		index = end
	}

	return Math.ceil(tokens)
}

// Template tokens around every message (role markers, separators).
export const MESSAGE_OVERHEAD_TOKENS = 8

const MAX_STRING_CHARS = 2000
// Also the listing limit of the apps' own tools, so a list is never cut twice.
export const MAX_ARRAY_ITEMS = 50

// Caps what one tool result can add to the prompt: long strings are cut and long lists shortened, with a
// note the model can relay, before the result is serialized.
export function capToolResult(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}… (truncated)` : value
	}

	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_ITEMS).map(capToolResult)

		return value.length > MAX_ARRAY_ITEMS ? [...items, `(${value.length - MAX_ARRAY_ITEMS} more not shown)`] : items
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capToolResult(entry)]))
	}

	return value
}

// What a list cut to `limit` rows adds: how many there are in all and how many it left out. A small model asked
// for a count adds the rows it sees to `more` and gets it wrong, so it is given the total to copy. Not for a
// listing a model pages through (listingPage): it passes a total there as the next page's offset.
export function listRest(count: number, limit: number = MAX_ARRAY_ITEMS): { total: number; more: number } | Record<never, never> {
	return count > limit ? { total: count, more: count - limit } : {}
}

// What opening a screen (open_route) returns. Told only that it opened, a small model went on to list what the
// screen shows, made up from earlier results (drive files as the trash's contents). Said without words, which
// pulled replies in other languages into English.
export function screenOpened(route: string): { opened: string; contentsRead: false } {
	return { opened: route, contentsRead: false }
}

// How many rows a long directory listing shows at a time; the model pages on with an offset.
export const LISTING_PAGE_ITEMS = 30

// Listings longer than this many pages say how many items they hold.
const LISTING_COUNTED_PAGES = 3

// The row an `offset` argument starts a listing page at.
export function listingOffset(offset: unknown): number {
	return typeof offset === "number" && offset > 0 ? Math.floor(offset) : 0
}

// The page of a listing an `offset` argument asks for: how many rows follow it and the offset of the next
// page (the model would otherwise pass the count of rows left as one), and, for an offset past the end, a
// note saying so (an empty page reads as an empty directory). A filtered listing's count is no directory's.
// A listing of many pages also says which rows it shows of how many ("1–30 of 214 items"): asked for a count,
// a model adds `more` to the rows it saw and gets it wrong. Not for a few pages, where that sum is easy and a
// count made the model answer a follow-up from it instead of reading the next page; never as a bare number,
// which beside `next` it passed as the next page's offset.
export function listingPage<T>(
	items: readonly T[],
	offset: unknown,
	{ filtered }: { filtered: boolean }
): { rows: T[]; offset: number; more: number; next: number; note?: string; shown?: string } {
	const start = listingOffset(offset)
	const end = start + LISTING_PAGE_ITEMS
	const count = items.length === 1 ? "1 item" : `${String(items.length)} items`

	return {
		rows: items.slice(start, end),
		offset: start,
		more: Math.max(0, items.length - end),
		next: end,
		...(items.length > LISTING_PAGE_ITEMS * LISTING_COUNTED_PAGES && start < items.length
			? {
					shown: `${String(start + 1)}–${String(Math.min(end, items.length))} of ${String(items.length)}${filtered ? " matching" : ""} items`
				}
			: {}),
		...(start > 0 && start >= items.length
			? {
					note: filtered
						? `Only ${count} ${items.length === 1 ? "matches" : "match"} the filters.`
						: `The directory holds only ${count}.`
				}
			: {})
	}
}

// A string stands bare where the app wrote it or spotlighting delimited it; anything else stays a quoted
// JSON string, so text another person wrote can never pass for a field of its own.
function rowValue(value: unknown, key?: string): string {
	if (typeof value === "string") {
		return (key !== undefined && isAppResultKey(key)) || isSpotlightSpan(value) ? value : JSON.stringify(value)
	}

	if (Array.isArray(value)) {
		return `[${value.map(entry => rowValue(entry)).join(", ")}]`
	}

	return isRecord(value) ? `(${rowText(value)})` : String(value)
}

// "⟦/Documents⟧" for the path "⟦/Documents/CV.pdf⟧" of "⟦CV.pdf⟧": the name is in the row already.
function parentOf(path: string, name: string): string | null {
	const delimited = isSpotlightSpan(path)

	if (delimited !== isSpotlightSpan(name)) {
		return null
	}

	const full = delimited ? path.slice(1, -1) : path
	const own = delimited ? name.slice(1, -1) : name

	if (own.length === 0 || !full.endsWith(`/${own}`)) {
		return null
	}

	const parent = full.slice(0, -own.length - 1) || "/"

	return delimited ? spotlightText(parent, { mode: "delimit" }) : JSON.stringify(parent)
}

const LEAD_KEYS: ReadonlySet<string> = new Set(["handle", "name", "title"])

// One listing row as a line, "f3 ⟦CV.pdf⟧ in=⟦/Documents⟧ size=1.2 MB favorite": keys and quotes are most of
// what a row of objects costs. Handle and name lead, a kind other than "file" stands alone (the handle's
// letter already says file), a true flag is its key.
function rowText(record: Record<string, unknown>): string {
	const name = record["name"] ?? record["title"]
	const parts: string[] = []

	for (const key of LEAD_KEYS) {
		const value = record[key]

		if (typeof value === "string") {
			parts.push(rowValue(value, key))
		}
	}

	for (const [key, value] of Object.entries(record)) {
		if (value === undefined || (LEAD_KEYS.has(key) && typeof value === "string")) {
			continue
		}

		if (key === "kind" && typeof value === "string") {
			if (value !== "file") {
				parts.push(rowValue(value, key))
			}

			continue
		}

		const parent = key === "path" && typeof value === "string" && typeof name === "string" ? parentOf(value, name) : null

		parts.push(parent !== null ? `in=${parent}` : value === true ? key : `${key}=${rowValue(value, key)}`)
	}

	return parts.join(" ")
}

// Only lists of items (records with a handle) become lines; others, such as contacts, read more reliably as
// objects. Transfers stay objects too: a row gains its handle only once its item exists, so the same list
// would switch format between calls. The cap's "(n more not shown)" is the one string among the records.
function compactRows(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) {
		return key !== "transfers" &&
			value.some(isRecord) &&
			value.every(entry => (isRecord(entry) && typeof entry["handle"] === "string") || typeof entry === "string")
			? value.map(entry => (isRecord(entry) ? rowText(entry) : entry))
			: value.map(entry => compactRows(entry))
	}

	return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, compactRows(entry, name)])) : value
}

// A tool result as the model reads it: capped, every list of items as one line per item. The browser
// engine reads about a hundred prompt tokens a second, so a listing's tokens are most of a step's wait.
export function serializeToolResult(value: unknown): string {
	return JSON.stringify(compactRows(capToolResult(value)))
}

// The largest n up to `max` whose text fits `maxTokens`; the text's estimate must grow with n.
function longestFitting(max: number, maxTokens: number, text: (n: number) => string): number {
	let low = 0
	let high = max

	while (low < high) {
		const middle = Math.ceil((low + high) / 2)

		if (estimateTokens(text(middle)) <= maxTokens) {
			low = middle
		} else {
			high = middle - 1
		}
	}

	return low
}

// Cuts `data` to `maxTokens`, keeping its start, or its end.
export function clipData(data: string, maxTokens: number, keepEnd: boolean): { data: string; clipped: boolean } {
	if (estimateTokens(data) <= maxTokens) {
		return {
			data,
			clipped: false
		}
	}

	const chars = Array.from(data)
	const part = (n: number) => (keepEnd ? chars.slice(chars.length - n) : chars.slice(0, n)).join("")

	return {
		data: part(longestFitting(chars.length, maxTokens, part)),
		clipped: true
	}
}

type MessageRow = { from: string; text: string; sent?: unknown }

function isMessageRow(value: unknown): value is MessageRow {
	return isRecord(value) && typeof value["from"] === "string" && typeof value["text"] === "string"
}

// Chat messages for the content extraction, within `maxTokens`: a day line whenever the day changes, then one
// line per message with sender and text as quoted JSON strings, so a text cannot start a message of its own.
// Past the budget the oldest messages go whole and the kept ones still start with their day line; a newest
// message too long alone keeps the end of its text. Undefined for rows of another shape.
export function messageLines(messages: unknown, maxTokens: number): { data: string; clipped: boolean } | undefined {
	if (!Array.isArray(messages) || !messages.every(isMessageRow)) {
		return undefined
	}

	const rows: readonly MessageRow[] = messages
	const render = (start: number, newestText?: string): string => {
		const lines: string[] = []
		let day: unknown = undefined

		for (let index = start; index < rows.length; index++) {
			const message = rows[index]

			if (message === undefined) {
				continue
			}

			if (typeof message.sent === "string" && message.sent !== day) {
				day = message.sent
				lines.push(message.sent)
			}

			const text = index === rows.length - 1 && newestText !== undefined ? newestText : message.text

			lines.push(`${JSON.stringify(message.from)}: ${JSON.stringify(text)}`)
		}

		return lines.join("\n")
	}
	const all = render(0)

	if (estimateTokens(all) <= maxTokens) {
		return {
			data: all,
			clipped: false
		}
	}

	const kept = longestFitting(rows.length, maxTokens, n => render(rows.length - n))

	if (kept > 0) {
		return {
			data: render(rows.length - kept),
			clipped: true
		}
	}

	const chars = Array.from(rows.at(-1)?.text ?? "")
	const end = (n: number) => render(rows.length - 1, chars.slice(chars.length - n).join(""))

	return {
		data: end(longestFitting(chars.length, maxTokens, end)),
		clipped: true
	}
}
