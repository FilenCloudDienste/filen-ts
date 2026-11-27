import { appHelpWords, searchTokens, type AppHelpEntry, type AppHelpWords } from "@filen/shared/assistant"
import type { SettingsRoute } from "@/features/settings/lib/settingsSections"

// The command palette's model: what a row is, where it leads, and how typed words rank the rows. Pure, so the ranking
// is tested without the app.

export type PaletteGroup = "recent" | "actions" | "navigation" | "files" | "notes" | "chats"

export type PaletteTarget =
	| { kind: "action"; id: string }
	| { kind: "settingsSection"; to: SettingsRoute }
	| { kind: "setting"; entry: AppHelpEntry }
	| { kind: "directory"; splat: string }
	| { kind: "file"; uuid: string; splat: string }
	| { kind: "note"; uuid: string }
	| { kind: "chat"; uuid: string }
	| { kind: "driveSearch"; query: string }

// A row's text in one language: its title, and the words that place it (its scope, its directory).
export interface PaletteText {
	readonly title: string
	readonly description: string
}

export interface PaletteItem {
	// Unique in one index; what the recent list remembers.
	readonly key: string
	readonly group: Exclude<PaletteGroup, "recent">
	readonly title: string
	readonly detail?: string
	// Shows the action's keys in effect.
	readonly actionId?: string
	// The text searched, in the app's language and in English; the title and detail when absent.
	readonly texts?: readonly PaletteText[]
	// Folded words given up front (a setting's, from the settings search's index).
	readonly words?: readonly AppHelpWords[]
	// Listed only for typed words: a setting is reached through its section otherwise.
	readonly queryOnly?: boolean
	readonly target: PaletteTarget
}

export interface PaletteSection {
	readonly group: PaletteGroup
	readonly items: readonly PaletteItem[]
}

// Group order when two score alike, and on an empty query.
const GROUP_ORDER: readonly PaletteGroup[] = ["recent", "navigation", "actions", "files", "notes", "chats"]

// Rows a group shows for typed words.
export const GROUP_LIMITS: Readonly<Record<Exclude<PaletteGroup, "recent">, number>> = {
	actions: 8,
	navigation: 8,
	files: 10,
	notes: 6,
	chats: 6
}

export const RECENT_LIMIT = 8

// Words of an index are folded once, on the first query that reaches the row: a palette opened and closed again folds
// nothing.
const foldedWords = new WeakMap<PaletteItem, readonly AppHelpWords[]>()

function wordsOf(item: PaletteItem): readonly AppHelpWords[] {
	if (item.words !== undefined) {
		return item.words
	}

	let words = foldedWords.get(item)

	if (words === undefined) {
		words = (item.texts ?? [{ title: item.title, description: item.detail ?? "" }]).map(text =>
			appHelpWords(text.title, text.description)
		)
		foldedWords.set(item, words)
	}

	return words
}

// A word that is the token scores most, one it begins next, one it holds (two letters or more) least.
function tokenScore(words: readonly string[], token: string): number {
	let best = 0

	for (const word of words) {
		if (word === token) {
			return 3
		}

		if (word.startsWith(token)) {
			best = 2
		} else if (best === 0 && token.length > 1 && word.includes(token)) {
			best = 1
		}
	}

	return best
}

// Every token must match the title or the description; a title match counts double. A row scores its best language.
export function paletteScore(item: PaletteItem, tokens: readonly string[]): number {
	let best = 0

	for (const language of wordsOf(item)) {
		let score = 0

		for (const token of tokens) {
			const inTitle = tokenScore(language.title, token) * 2
			const inDescription = tokenScore(language.description, token)
			const matched = Math.max(inTitle, inDescription)

			if (matched === 0) {
				score = 0
				break
			}

			score += matched
		}

		best = Math.max(best, score)
	}

	return best
}

export interface RankOptions {
	// Keys of the rows picked lately, latest first.
	recent: readonly string[]
	// Offers the hand-off to Cloud Drive's search for typed words.
	driveSearch: boolean
}

function groupRank(group: PaletteGroup): number {
	return GROUP_ORDER.indexOf(group)
}

// The rows for `query`. Empty: the recent rows, then the places and the actions. Typed: every group's best matches,
// the recent ones first among equals, the group holding the best match first.
export function rankPalette(items: readonly PaletteItem[], query: string, options: RankOptions): PaletteSection[] {
	const tokens = [...new Set(searchTokens(query))]

	if (tokens.length === 0) {
		return emptyQuerySections(items, options.recent)
	}

	const recentRank = new Map(options.recent.map((key, index) => [key, index]))
	const byGroup = new Map<PaletteItem["group"], { item: PaletteItem; score: number; index: number }[]>()

	items.forEach((item, index) => {
		const score = paletteScore(item, tokens)

		if (score === 0) {
			return
		}

		const scored = byGroup.get(item.group)

		if (scored === undefined) {
			byGroup.set(item.group, [{ item, score, index }])
		} else {
			scored.push({ item, score, index })
		}
	})

	const sections: (PaletteSection & { best: number })[] = []

	for (const [group, scored] of byGroup) {
		scored.sort(
			(a, b) =>
				b.score - a.score ||
				(recentRank.get(a.item.key) ?? Infinity) - (recentRank.get(b.item.key) ?? Infinity) ||
				a.index - b.index
		)

		const top = scored.slice(0, GROUP_LIMITS[group])

		sections.push({ group, items: top.map(entry => entry.item), best: top[0]?.score ?? 0 })
	}

	sections.sort((a, b) => b.best - a.best || groupRank(a.group) - groupRank(b.group))

	const ranked: PaletteSection[] = sections.map(({ group, items: rows }) => ({ group, items: rows }))

	if (options.driveSearch) {
		const handOff = driveSearchItem(query.trim())
		const files = ranked.find(section => section.group === "files")

		if (files === undefined) {
			ranked.push({ group: "files", items: [handOff] })
		} else {
			ranked[ranked.indexOf(files)] = { group: "files", items: [...files.items, handOff] }
		}
	}

	return ranked
}

export const DRIVE_SEARCH_KEY = "driveSearch"

function driveSearchItem(query: string): PaletteItem {
	return { key: DRIVE_SEARCH_KEY, group: "files", title: query, target: { kind: "driveSearch", query } }
}

function emptyQuerySections(items: readonly PaletteItem[], recent: readonly string[]): PaletteSection[] {
	const byKey = new Map(items.map(item => [item.key, item]))
	const recentItems = recent
		.map(key => byKey.get(key))
		.filter((item): item is PaletteItem => item !== undefined && item.queryOnly !== true)
		.slice(0, RECENT_LIMIT)
	const shown = new Set(recentItems.map(item => item.key))
	const rest = (group: PaletteItem["group"]) =>
		items.filter(item => item.group === group && item.queryOnly !== true && !shown.has(item.key))
	const sections: PaletteSection[] = [
		{ group: "recent", items: recentItems },
		{ group: "navigation", items: rest("navigation") },
		{ group: "actions", items: rest("actions") }
	]

	return sections.filter(section => section.items.length > 0)
}

// The rows in the order the list shows them, for the arrow keys.
export function flattenSections(sections: readonly PaletteSection[]): PaletteItem[] {
	return sections.flatMap(section => section.items)
}

// The recent list after picking `key`: it first, at most `limit`, none twice. The drive search hand-off is no row to
// come back to.
export function withRecent(recent: readonly string[], key: string, limit = RECENT_LIMIT): string[] {
	if (key === DRIVE_SEARCH_KEY) {
		return [...recent]
	}

	return [key, ...recent.filter(existing => existing !== key)].slice(0, limit)
}
