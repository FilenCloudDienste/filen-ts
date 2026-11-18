import { MAX_WORD_LENGTH } from "./protocol"

// The user's dictionary as stored (end-to-end encrypted, as a file the apps sync): words the user added,
// accepted in every language. Each word is a last-writer-wins register, so devices that edit offline merge
// without losing an addition or resurrecting a removal; removals stay as tombstones (the list is small).
//
// { "v": 1, "words": { "<word>": <stamp> }, "removed": { "<word>": <stamp> } }
//
// Stamps are milliseconds since the epoch; on a tie the word stays.

export const USER_DICTIONARY_FILE_NAME = "user-dictionary.v1.json"
export const USER_DICTIONARY_VERSION = 1
export const MAX_USER_WORD_LENGTH = MAX_WORD_LENGTH
// A bound against a corrupted or hostile file, far above any real list.
export const MAX_USER_WORDS = 50_000

export interface UserDictionaryDoc {
	readonly v: typeof USER_DICTIONARY_VERSION
	readonly words: Readonly<Record<string, number>>
	readonly removed: Readonly<Record<string, number>>
}

// The file was written by a newer format: it must not be overwritten by this one.
export class UserDictionaryVersionError extends Error {
	readonly version: unknown

	constructor(version: unknown) {
		super(`Unsupported user dictionary version ${String(version)}`)
		this.name = "UserDictionaryVersionError"
		this.version = version
	}
}

export function emptyUserDictionary(): UserDictionaryDoc {
	return { v: USER_DICTIONARY_VERSION, words: record(), removed: record() }
}

// The form a word is stored in (NFC, trimmed), or undefined when it cannot be a dictionary word.
export function normalizeUserWord(word: string): string | undefined {
	const normalized = word.trim().normalize("NFC")

	if (normalized.length === 0 || normalized.length > MAX_USER_WORD_LENGTH || /\s/u.test(normalized)) return undefined

	return normalized
}

// Stamps stay exact integers in JSON and arithmetic (a stamp at the cap can no longer be outbid, which only a
// hostile file reaches).
function clampStamp(stamp: number): number {
	return Math.min(Math.max(Math.trunc(stamp), -Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
}

// Null-prototype records: words are arbitrary keys ("__proto__" included).
function record(): Record<string, number> {
	return Object.create(null) as Record<string, number>
}

function stamps(value: unknown): Record<string, number> {
	const out = record()

	if (typeof value !== "object" || value === null || Array.isArray(value)) return out

	let count = 0

	for (const [word, stamp] of Object.entries(value)) {
		const normalized = normalizeUserWord(word)

		if (normalized === undefined || typeof stamp !== "number" || !Number.isFinite(stamp)) continue

		out[normalized] = Math.max(out[normalized] ?? Number.NEGATIVE_INFINITY, clampStamp(stamp))

		if (++count >= MAX_USER_WORDS) break
	}

	return out
}

// Reads a stored file; entries that are not valid are dropped. Throws UserDictionaryVersionError for a newer
// format and SyntaxError for text that is not JSON.
export function parseUserDictionary(text: string): UserDictionaryDoc {
	const value: unknown = JSON.parse(text)

	if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyUserDictionary()

	const version: unknown = Reflect.get(value, "v")

	if (typeof version === "number" && version > USER_DICTIONARY_VERSION) throw new UserDictionaryVersionError(version)

	return { v: USER_DICTIONARY_VERSION, words: stamps(Reflect.get(value, "words")), removed: stamps(Reflect.get(value, "removed")) }
}

function sorted(stamps: Readonly<Record<string, number>>): Record<string, number> {
	const out = record()

	for (const key of Object.keys(stamps).sort()) out[key] = stamps[key] ?? 0

	return out
}

// Stable text (sorted keys), so equal documents serialise identically.
export function serializeUserDictionary(doc: UserDictionaryDoc): string {
	return JSON.stringify({ v: USER_DICTIONARY_VERSION, words: sorted(doc.words), removed: sorted(doc.removed) })
}

function mergeStamps(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
	const out = Object.assign(record(), a)

	for (const [word, stamp] of Object.entries(b)) out[word] = Math.max(out[word] ?? Number.NEGATIVE_INFINITY, stamp)

	return out
}

export function mergeUserDictionaries(a: UserDictionaryDoc, b: UserDictionaryDoc): UserDictionaryDoc {
	return { v: USER_DICTIONARY_VERSION, words: mergeStamps(a.words, b.words), removed: mergeStamps(a.removed, b.removed) }
}

export function hasUserWord(doc: UserDictionaryDoc, word: string): boolean {
	const added = doc.words[word]

	return added !== undefined && added >= (doc.removed[word] ?? Number.NEGATIVE_INFINITY)
}

// The words in effect, sorted.
export function userWords(doc: UserDictionaryDoc): string[] {
	return Object.keys(doc.words)
		.filter(word => hasUserWord(doc, word))
		.sort()
}

// The document with `word` added at `stamp` (unchanged when the word is invalid or already in).
export function addUserWord(doc: UserDictionaryDoc, word: string, stamp: number): UserDictionaryDoc {
	const normalized = normalizeUserWord(word)

	if (normalized === undefined || hasUserWord(doc, normalized)) return doc

	// Past the tombstone even when this device's clock is behind the one that removed it.
	const at = clampStamp(Math.max(stamp, doc.removed[normalized] ?? Number.NEGATIVE_INFINITY))

	return { v: USER_DICTIONARY_VERSION, words: Object.assign(record(), doc.words, { [normalized]: at }), removed: doc.removed }
}

export function removeUserWord(doc: UserDictionaryDoc, word: string, stamp: number): UserDictionaryDoc {
	const normalized = normalizeUserWord(word)

	if (normalized === undefined || !hasUserWord(doc, normalized)) return doc

	const at = clampStamp(Math.max(stamp, (doc.words[normalized] ?? Number.NEGATIVE_INFINITY) + 1))

	return { v: USER_DICTIONARY_VERSION, words: doc.words, removed: Object.assign(record(), doc.removed, { [normalized]: at }) }
}

// Whether two documents hold the same entries (an unchanged merge needs no upload).
export function sameUserDictionary(a: UserDictionaryDoc, b: UserDictionaryDoc): boolean {
	return serializeUserDictionary(a) === serializeUserDictionary(b)
}
