import { parseNumbersFromString } from "./misc"

// Cached, numeric-aware ("natural sort") string comparator infrastructure used as the core of
// drive-item sorting on both platforms — digit-run parsing with memoization, uuid-derived tiebreak
// number, lowercase memoization. Caches are module-level (one set per process, matching both apps).
//
// clearNaturalSortCaches() exists because the caches key on decrypted names (and uuids), which must
// not carry one account's data into the next session. Mobile wires it into its logout flow. Web has
// no equivalent call: its logout does a full `location.reload()`, which discards the whole module
// graph (these Maps included) — that is a verified non-gap, not a missing wire-up, so don't add one.
const uuidCache = new Map<string, number>()
const lowerCache = new Map<string, string>()
const numericPartsCache = new Map<string, (string | number)[]>()

export function clearNaturalSortCaches(): void {
	uuidCache.clear()
	lowerCache.clear()
	numericPartsCache.clear()
}

export function getUuidNumber(uuid: string): number {
	let cached = uuidCache.get(uuid)

	if (cached === undefined) {
		cached = parseNumbersFromString(uuid)

		uuidCache.set(uuid, cached)
	}

	return cached
}

export function getLowerName(name: string): string {
	let cached = lowerCache.get(name)

	if (cached === undefined) {
		cached = name.toLowerCase()

		lowerCache.set(name, cached)
	}

	return cached
}

export function getNumericParts(str: string): (string | number)[] {
	let cached = numericPartsCache.get(str)

	if (!cached) {
		cached = []

		// Run-sliced scan: runs are detected via charCodeAt only and materialized with ONE slice
		// each, so a name with k runs costs k allocations, not one per character. Digit runs keep
		// parseInt so numeric semantics (incl. precision rounding of absurdly long digit runs)
		// match a straightforward numeric parse.
		const length = str.length
		let runStart = 0
		let runIsDigit = false
		let hasRun = false

		for (let i = 0; i < length; i++) {
			const code = str.charCodeAt(i)
			const isDigit = code >= 48 && code <= 57

			if (!hasRun) {
				hasRun = true
				runIsDigit = isDigit
				runStart = i

				continue
			}

			if (isDigit !== runIsDigit) {
				cached.push(runIsDigit ? parseInt(str.slice(runStart, i), 10) : str.slice(runStart, i))

				runStart = i
				runIsDigit = isDigit
			}
		}

		if (hasRun) {
			cached.push(runIsDigit ? parseInt(str.slice(runStart), 10) : str.slice(runStart))
		}

		numericPartsCache.set(str, cached)
	}

	return cached
}

export function comparePartsNumeric(aParts: (string | number)[], bParts: (string | number)[]): number {
	// Identical strings resolve to the SAME cached parts array (numericPartsCache), so reference
	// equality short-circuits the whole walk — tie-dense comparisons (same type across a group,
	// duplicated names) become O(1) instead of O(parts).
	if (aParts === bParts) {
		return 0
	}

	const minLen = Math.min(aParts.length, bParts.length)

	for (let i = 0; i < minLen; i++) {
		const aPart = aParts[i]
		const bPart = bParts[i]

		if (typeof aPart === "number" && typeof bPart === "number") {
			if (aPart !== bPart) {
				return aPart - bPart
			}
		} else if (typeof aPart === "string" && typeof bPart === "string") {
			if (aPart !== bPart) {
				return aPart < bPart ? -1 : 1
			}
		} else {
			return typeof aPart === "number" ? -1 : 1
		}
	}

	return aParts.length - bParts.length
}
