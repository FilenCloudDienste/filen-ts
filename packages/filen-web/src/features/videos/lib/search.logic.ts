import { compareIds, fastLocaleCompare } from "@filen/shared"
import type { VideoHomeItem, VideoTitleView } from "@/workers/videoIndex/view.logic"

// Library search: an in-memory index over what the library already holds (titles, series titles, years, directory
// names, episode titles). Nothing is listed or probed to answer a query. Plain and DOM-free.

export const SEARCH_DEBOUNCE_MS = 50
// Results shown per group; the rest is counted.
export const SEARCH_GROUP_LIMIT = 48

const MARKS = /\p{M}+/gu
const SEPARATORS = /[^\p{L}\p{N}]+/u

// Letters NFKD leaves whole, spelled the way a keyboard without them would type them.
const FOLDS: Readonly<Record<string, string>> = {
	ø: "o",
	ß: "ss",
	æ: "ae",
	œ: "oe",
	ł: "l",
	đ: "d",
	ð: "d",
	þ: "th",
	ı: "i",
	ħ: "h",
	ŧ: "t"
}
const FOLDED = new RegExp(`[${Object.keys(FOLDS).join("")}]`, "gu")

// NFKD, marks removed, lowercase, a few letters spelled out: "Amélie" and "AMELIE", "Søren" and "Soren" read the same.
export function normalizeSearchText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(MARKS, "")
		.toLowerCase()
		.replace(FOLDED, letter => FOLDS[letter] ?? letter)
}

export function searchTokens(text: string): string[] {
	return splitTokens(normalizeSearchText(text))
}

function splitTokens(normalized: string): string[] {
	return normalized.split(SEPARATORS).filter(token => token.length > 0)
}

// Scripts written without spaces between words: one token is a whole phrase there.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

// What an index holds of `text`: its tokens and, inside a token with unspaced-script letters, the suffix starting at
// each of them and right after each of them, so a query word from the middle of "千と千尋の神隠し" or "報告書Archive"
// still starts one. Folded like the query (normalizeSearchText) before the script test and the split.
function indexTokens(text: string): string[] {
	const normalized = normalizeSearchText(text)
	const tokens = splitTokens(normalized)

	if (!UNSPACED.test(normalized)) {
		return tokens
	}

	const out: string[] = []

	for (const token of tokens) {
		out.push(token)

		if (!UNSPACED.test(token)) {
			continue
		}

		let offset = 0
		let afterUnspaced = false

		for (const char of token) {
			const unspaced = UNSPACED.test(char)

			if (offset > 0 && (unspaced || afterUnspaced)) {
				out.push(token.slice(offset))
			}

			afterUnspaced = unspaced
			offset += char.length
		}
	}

	return out
}

export type SearchGroupKind = "movies" | "shows" | "episodes" | "other"

interface SearchEntry {
	group: SearchGroupKind
	title: VideoTitleView
	item: VideoHomeItem | null
	// The name's tokens joined by single spaces: what a whole query is matched against as a prefix, so "spider man"
	// ranks "Spider-Man" first.
	name: string
}

export interface VideoSearchIndex {
	entries: readonly SearchEntry[]
	// Every distinct token, sorted, and the entries holding each.
	tokens: readonly string[]
	postings: ReadonlyMap<string, readonly number[]>
}

function addTokens(postings: Map<string, number[]>, entry: number, texts: readonly string[]): void {
	const seen = new Set<string>()

	for (const text of texts) {
		for (const token of indexTokens(text)) {
			if (seen.has(token)) {
				continue
			}

			seen.add(token)

			let list = postings.get(token)

			if (list === undefined) {
				list = []
				postings.set(token, list)
			}

			list.push(entry)
		}
	}
}

// Titles match on their name, year and directory names; an episode only on its own title.
export function buildVideoSearchIndex(input: { titles: readonly VideoTitleView[]; items: readonly VideoHomeItem[] }): VideoSearchIndex {
	const steps = buildVideoSearchIndexSteps(input)

	for (;;) {
		const step = steps.next()

		if (step.done === true) {
			return step.value
		}
	}
}

// Entries indexed between yields of buildVideoSearchIndexSteps.
const INDEX_STEP = 256

// buildVideoSearchIndex in steps (yields between runs of entries).
export function* buildVideoSearchIndexSteps({
	titles,
	items
}: {
	titles: readonly VideoTitleView[]
	items: readonly VideoHomeItem[]
}): Generator<void, VideoSearchIndex> {
	const folders = new Map<string, Set<string>>()

	for (const item of items) {
		if (item.itemClass === "episode" || item.folder.length === 0) {
			continue
		}

		let set = folders.get(item.titleId)

		if (set === undefined) {
			set = new Set()
			folders.set(item.titleId, set)
		}

		set.add(item.folder)
	}

	const entries: SearchEntry[] = []
	const postings = new Map<string, number[]>()
	const byId = new Map<string, VideoTitleView>()

	for (const title of titles) {
		if (entries.length % INDEX_STEP === INDEX_STEP - 1) {
			yield
		}

		byId.set(title.id, title)
		addTokens(postings, entries.length, [title.title, title.year > 0 ? String(title.year) : "", ...(folders.get(title.id) ?? [])])
		entries.push({
			group: title.kind === "movie" ? "movies" : title.kind === "series" ? "shows" : "other",
			title,
			item: null,
			name: searchTokens(title.title).join(" ")
		})
	}

	const seenGroups = new Set<string>()

	for (let at = 0; at < items.length; at++) {
		const item = items[at]

		if (at % (INDEX_STEP * 4) === INDEX_STEP * 4 - 1) {
			yield
		}

		if (item === undefined) {
			continue
		}

		const title = item.itemClass === "episode" && item.episodeTitle.length > 0 ? byId.get(item.titleId) : undefined

		// One result per episode, not per version.
		if (title === undefined || seenGroups.has(item.group)) {
			continue
		}

		seenGroups.add(item.group)
		addTokens(postings, entries.length, [item.episodeTitle])
		entries.push({
			group: "episodes",
			title,
			item,
			name: searchTokens(item.episodeTitle).join(" ")
		})
	}

	yield

	return {
		entries,
		tokens: [...postings.keys()].sort(),
		postings
	}
}

// The first index in sorted `tokens` not below `value`.
function lowerBound(tokens: readonly string[], value: string): number {
	let low = 0
	let high = tokens.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((tokens[middle] ?? "") < value) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return low
}

// Entries holding a token that starts with `prefix`.
function prefixMatches(index: VideoSearchIndex, prefix: string): Set<number> {
	const out = new Set<number>()

	for (let i = lowerBound(index.tokens, prefix); i < index.tokens.length; i++) {
		const token = index.tokens[i] ?? ""

		if (!token.startsWith(prefix)) {
			break
		}

		for (const entry of index.postings.get(token) ?? []) {
			out.add(entry)
		}
	}

	return out
}

export interface SearchResultGroup {
	kind: SearchGroupKind
	results: { title: VideoTitleView; item: VideoHomeItem | null }[]
	total: number
}

const GROUP_ORDER: readonly SearchGroupKind[] = ["movies", "shows", "episodes", "other"]

// Every query token must start a token of the entry (in unspaced scripts, a suffix of one: indexTokens). Names the
// whole query starts rank first, then by name.
export function searchVideos({
	index,
	query,
	limit = SEARCH_GROUP_LIMIT
}: {
	index: VideoSearchIndex
	query: string
	limit?: number
}): SearchResultGroup[] {
	const tokens = searchTokens(query)

	if (tokens.length === 0) {
		return []
	}

	// Longest token first: usually the narrowest set to intersect the others with.
	const [first, ...rest] = [...tokens].sort((a, b) => b.length - a.length)
	let matched = prefixMatches(index, first ?? "")

	for (const token of rest) {
		const found = prefixMatches(index, token)

		matched = new Set([...matched].filter(entry => found.has(entry)))

		if (matched.size === 0) {
			return []
		}
	}

	const whole = tokens.join(" ")
	const groups = new Map<SearchGroupKind, SearchEntry[]>()

	for (const position of matched) {
		const entry = index.entries[position]

		if (entry === undefined) {
			continue
		}

		let list = groups.get(entry.group)

		if (list === undefined) {
			list = []
			groups.set(entry.group, list)
		}

		list.push(entry)
	}

	const out: SearchResultGroup[] = []

	for (const kind of GROUP_ORDER) {
		const list = groups.get(kind)

		if (list === undefined) {
			continue
		}

		list.sort(
			(a, b) =>
				Number(b.name.startsWith(whole)) - Number(a.name.startsWith(whole)) ||
				fastLocaleCompare(a.name, b.name) ||
				fastLocaleCompare(a.title.sortName, b.title.sortName) ||
				compareIds(a.title.id, b.title.id) ||
				compareIds(a.item?.stableUuid ?? "", b.item?.stableUuid ?? "")
		)
		out.push({
			kind,
			results: list.slice(0, limit).map(entry => ({ title: entry.title, item: entry.item })),
			total: list.length
		})
	}

	return out
}

// Per title, the tokens a grid's own search box matches: its name and year.
export function titleSearchTokens(titles: readonly VideoTitleView[]): Map<string, string[]> {
	return new Map(titles.map(title => [title.id, indexTokens(`${title.title} ${title.year > 0 ? String(title.year) : ""}`)]))
}

// The titles every query token starts a token (or indexed suffix) of, in their order.
export function filterTitlesByQuery({
	titles,
	query,
	tokens
}: {
	titles: readonly VideoTitleView[]
	query: string
	tokens: ReadonlyMap<string, readonly string[]>
}): VideoTitleView[] {
	const wanted = searchTokens(query)

	if (wanted.length === 0) {
		return [...titles]
	}

	return titles.filter(title => {
		const own = tokens.get(title.id) ?? []

		return wanted.every(prefix => own.some(token => token.startsWith(prefix)))
	})
}
