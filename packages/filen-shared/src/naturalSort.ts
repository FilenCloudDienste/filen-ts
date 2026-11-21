import { compareTextRuns, parseNumbersFromString } from "./misc"

// Cached, numeric-aware ("natural sort") string comparator infrastructure used as the core of
// drive-item sorting on both platforms — lowercased digit-run parsing memoized per raw name, and a
// uuid-derived tiebreak number. Caches are module-level (one set per process, matching both apps).
//
// clearNaturalSortCaches() exists because the caches key on decrypted names (and uuids), which must
// not carry one account's data into the next session. Mobile wires it into its logout flow; web's
// logout does a full `location.reload()`, which discards these Maps with the module graph.
//
// Growth is bounded separately: a session that stays open for days keeps adding every name it
// lists, so a map that reaches NATURAL_SORT_CACHE_CAP entries is cleared before the next insert.
// A clear mid-sort only costs re-parses (identity in comparePartsNumeric is a fast path, never the
// answer). The cap sits well above the largest realistic listing so a single sort never thrashes.
export const NATURAL_SORT_CACHE_CAP = 250_000

/**
 * A text run holding a non-ASCII code unit. Kept apart from plain strings so comparePartsNumeric can order two ASCII
 * runs with the engine's native string comparison and pay for compareTextRuns only when a run needs it.
 */
export interface NonAsciiTextRun {
	readonly text: string
}

/** One run of a name: a digit run's value, an ASCII text run, or a text run holding non-ASCII. */
export type NamePart = number | string | NonAsciiTextRun

const uuidCache = new Map<string, number>()
const namePartsCache = new Map<string, NamePart[]>()

export function clearNaturalSortCaches(): void {
	uuidCache.clear()
	namePartsCache.clear()
}

export function getUuidNumber(uuid: string): number {
	let cached = uuidCache.get(uuid)

	if (cached === undefined) {
		cached = parseNumbersFromString(uuid)

		if (uuidCache.size >= NATURAL_SORT_CACHE_CAP) {
			uuidCache.clear()
		}

		uuidCache.set(uuid, cached)
	}

	return cached
}

// Keyed by the raw key, so a single lookup covers both the lowercasing and the parse.
export function getNameParts(key: string): NamePart[] {
	let cached = namePartsCache.get(key)

	if (!cached) {
		cached = []

		const str = key.toLowerCase()

		// Run-sliced scan: runs are detected via charCodeAt only and materialized with ONE slice
		// each, so a name with k runs costs k allocations, not one per character. Digit runs keep
		// parseInt so numeric semantics (incl. precision rounding of absurdly long digit runs)
		// match a straightforward numeric parse.
		const length = str.length
		let runStart = 0
		let runIsDigit = false
		let runIsAscii = true
		let hasRun = false

		for (let i = 0; i < length; i++) {
			const code = str.charCodeAt(i)
			const isDigit = code >= 48 && code <= 57

			if (!hasRun) {
				hasRun = true
				runIsDigit = isDigit
				runIsAscii = code < 128
				runStart = i

				continue
			}

			if (isDigit !== runIsDigit) {
				cached.push(toNamePart(str.slice(runStart, i), runIsDigit, runIsAscii))

				runStart = i
				runIsDigit = isDigit
				runIsAscii = code < 128
			} else if (code >= 128) {
				runIsAscii = false
			}
		}

		if (hasRun) {
			cached.push(toNamePart(str.slice(runStart), runIsDigit, runIsAscii))
		}

		if (namePartsCache.size >= NATURAL_SORT_CACHE_CAP) {
			namePartsCache.clear()
		}

		namePartsCache.set(key, cached)
	}

	return cached
}

function toNamePart(run: string, isDigit: boolean, isAscii: boolean): NamePart {
	if (isDigit) {
		return parseInt(run, 10)
	}

	return isAscii ? run : { text: run }
}

// The index type admits undefined; a parts array never holds it.
function textOf(part: string | NonAsciiTextRun | undefined): string {
	return typeof part === "string" ? part : part === undefined ? "" : part.text
}

export function comparePartsNumeric(aParts: NamePart[], bParts: NamePart[]): number {
	// Identical keys resolve to the SAME cached parts array (namePartsCache), so reference
	// equality short-circuits the whole walk — tie-dense comparisons (same type across a group,
	// duplicated names) become O(1) instead of O(parts).
	if (aParts === bParts) {
		return 0
	}

	const minLen = Math.min(aParts.length, bParts.length)

	for (let i = 0; i < minLen; i++) {
		const aPart = aParts[i]
		const bPart = bParts[i]

		if (typeof aPart === "number") {
			if (typeof bPart !== "number") {
				return -1
			}

			if (aPart !== bPart) {
				return aPart - bPart
			}
		} else if (typeof bPart === "number") {
			return 1
		} else if (typeof aPart === "string" && typeof bPart === "string") {
			// Two ASCII runs: code-unit order, which the native comparison gives without a JS loop.
			if (aPart !== bPart) {
				return aPart < bPart ? -1 : 1
			}
		} else {
			const order = compareTextRuns(textOf(aPart), textOf(bPart))

			if (order !== 0) {
				return order
			}
		}
	}

	return aParts.length - bParts.length
}

// The same order as getNameParts + comparePartsNumeric, without allocating and without the caches, for names
// compared once (archive listings, comic pages) that must not be pinned in the module-level maps. Digit runs compare
// by value, text runs through compareTextRuns, a digit sorts before anything else, and a name ending first sorts first.
// naturalSort reads a digit run through parseInt, which rounds past 15 digits; this does too, where it matters.
const EXACT_DIGITS = 15

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

function compareDigitRuns(a: string, aStart: number, aEnd: number, b: string, bStart: number, bEnd: number): number {
	let i = aStart
	let j = bStart

	// Leading zeros carry no value; the last digit stays.
	while (i < aEnd - 1 && a.charCodeAt(i) === 48) {
		i++
	}

	while (j < bEnd - 1 && b.charCodeAt(j) === 48) {
		j++
	}

	const aLength = aEnd - i
	const bLength = bEnd - j

	if (aLength > EXACT_DIGITS && bLength > EXACT_DIGITS) {
		const aValue = parseInt(a.slice(aStart, aEnd), 10)
		const bValue = parseInt(b.slice(bStart, bEnd), 10)

		return aValue === bValue ? 0 : aValue < bValue ? -1 : 1
	}

	if (aLength !== bLength) {
		return aLength < bLength ? -1 : 1
	}

	for (; i < aEnd; i++, j++) {
		const difference = a.charCodeAt(i) - b.charCodeAt(j)

		if (difference !== 0) {
			return difference < 0 ? -1 : 1
		}
	}

	return 0
}

export function compareNames(a: string, b: string): number {
	if (a === b) {
		return 0
	}

	const aLength = a.length
	const bLength = b.length
	let i = 0
	let j = 0
	// Where the current run began, the same text in both up to i / j.
	let aRun = 0
	let bRun = 0

	while (i < aLength && j < bLength) {
		let ca = a.charCodeAt(i)
		let cb = b.charCodeAt(j)
		const aDigit = isDigit(ca)
		const bDigit = isDigit(cb)

		if (aDigit && bDigit) {
			let aEnd = i + 1
			let bEnd = j + 1

			while (aEnd < aLength && isDigit(a.charCodeAt(aEnd))) {
				aEnd++
			}

			while (bEnd < bLength && isDigit(b.charCodeAt(bEnd))) {
				bEnd++
			}

			const order = compareDigitRuns(a, i, aEnd, b, j, bEnd)

			if (order !== 0) {
				return order
			}

			i = aRun = aEnd
			j = bRun = bEnd

			continue
		}

		if (aDigit !== bDigit) {
			return aDigit ? -1 : 1
		}

		if (ca !== cb) {
			if (ca >= 128 || cb >= 128) {
				// The text runs as getNameParts would cut them, lowercased the same way.
				let aEnd = i + 1
				let bEnd = j + 1

				while (aEnd < aLength && !isDigit(a.charCodeAt(aEnd))) {
					aEnd++
				}

				while (bEnd < bLength && !isDigit(b.charCodeAt(bEnd))) {
					bEnd++
				}

				const order = compareTextRuns(a.slice(aRun, aEnd).toLowerCase(), b.slice(bRun, bEnd).toLowerCase())

				if (order !== 0) {
					return order
				}

				i = aRun = aEnd
				j = bRun = bEnd

				continue
			}

			if (ca >= 65 && ca <= 90) {
				ca += 32
			}

			if (cb >= 65 && cb <= 90) {
				cb += 32
			}

			if (ca !== cb) {
				return ca < cb ? -1 : 1
			}
		}

		i++
		j++
	}

	const aLeft = aLength - i
	const bLeft = bLength - j

	return aLeft === bLeft ? 0 : aLeft < bLeft ? -1 : 1
}

/** The last link of every list comparator: a unique id by code unit, 0 only for the same id. */
export function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Natural, case-insensitive name, then the unique id: a total order over any list whose items carry both, so equal
 * names never fall back to the input's order.
 */
export function compareNamesThenIds(aName: string, aId: string, bName: string, bId: string): number {
	const order = compareNames(aName, bName)

	return order !== 0 ? order : compareIds(aId, bId)
}
