// Several files of one title (cuts, resolutions, encodes) shown as one item with a version picker.

import { dynamicRangeLabel, normalizeSeparators, parseResolution, resolutionLabel } from "./naming"

const LABEL_OPENERS = " \t._-[{("
const LABEL_CLOSERS = " \t._-]})"

// Separators and brackets off both ends, by hand: an anchored-at-end pattern backtracks quadratically on long runs.
function trimLabel(text: string): string {
	let start = 0
	let end = text.length

	while (start < end && LABEL_OPENERS.includes(text.charAt(start))) {
		start++
	}

	while (end > start && LABEL_CLOSERS.includes(text.charAt(end - 1))) {
		end--
	}

	return text.slice(start, end)
}
const EDITION_TAG = /^edition[-=]/iu
// Versions of one title share its year, so a year left in the differing text says nothing ("Heat (1995)" vs
// "Heat.1995.2160p").
const YEAR_TOKEN = /(?<![\p{L}\p{N}])[([]?(?:18|19|20)\d\d[)\]]?(?![\p{L}\p{N}])/gu
const WORD_CHAR = /[\p{L}\p{N}]/u

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && WORD_CHAR.test(char)
}

// Text a version adds after the directory name, or null when the stem is not a version of that directory's title.
// A version stem is the directory name followed by nothing, a separator ("-", "_", ".") or a bracketed label.
export function versionSuffix(directoryName: string, stem: string): string | null {
	if (directoryName.length < 2 || stem.length < directoryName.length) {
		return null
	}

	if (stem.slice(0, directoryName.length).toLowerCase() !== directoryName.toLowerCase()) {
		return null
	}

	const rest = stem.slice(directoryName.length).trimStart()

	if (rest.length === 0) {
		return ""
	}

	const first = rest[0]

	return first === "-" || first === "_" || first === "." || first === "[" || first === "{" ? rest : null
}

// Picker label for a version: its own suffix text ("Director's Cut", "1080p"), else what the full name says about
// resolution and dynamic range. Empty when nothing distinguishes it; the UI numbers those.
export function versionLabel(suffix: string, stem: string): string {
	const own = trimLabel(normalizeSeparators(trimLabel(suffix).replace(EDITION_TAG, "")).replace(YEAR_TOKEN, " ").trim())

	if (own.length > 0) {
		return own
	}

	return [resolutionLabel(parseResolution(stem)), dynamicRangeLabel(stem)].filter(part => part.length > 0).join(" ")
}

// Length of the shared start of the stems, backed off to a token edge so "x 1080p" / "x 1440p" share "x ".
export function commonStemPrefix(stems: readonly string[]): number {
	const first = stems[0]

	if (first === undefined || stems.length < 2) {
		return 0
	}

	let length = first.length

	for (let s = 1; s < stems.length; s++) {
		const other = stems[s] ?? ""

		length = Math.min(length, other.length)

		for (let i = 0; i < length; i++) {
			if (first.charCodeAt(i) !== other.charCodeAt(i) && first[i]?.toLowerCase() !== other[i]?.toLowerCase()) {
				length = i

				break
			}
		}
	}

	while (length > 0 && isWordChar(first[length - 1]) && stems.some(stem => isWordChar(stem[length]))) {
		length--
	}

	return length
}

// The last link of the library's comparators: an id (stable uuid, directory uuid) by code unit, 0 only for the same id.
export function compareVideoIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

let collator: Intl.Collator | null = null

export function compareVideoNames(a: string, b: string): number {
	collator ??= new Intl.Collator(undefined, {
		numeric: true,
		sensitivity: "base"
	})

	return collator.compare(a, b)
}

export interface VersionCandidate {
	name: string
	height: number
}

let fixedCollator: Intl.Collator | null = null

// Picker order: versions whose names state a resolution first, highest first; the rest by name. The first one is
// the title's identity (movie id, episode override key), so names compare under one fixed locale and then by code
// unit: every device picks the same primary whatever its own locale.
export function compareVersionCandidates(a: VersionCandidate, b: VersionCandidate): number {
	if (a.height !== b.height) {
		return b.height - a.height
	}

	fixedCollator ??= new Intl.Collator("en", {
		numeric: true,
		sensitivity: "base"
	})

	return fixedCollator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
