// Bonus material: trailers, featurettes, deleted scenes… recognised by directory name or by a "-type" name suffix.

export type ExtraType = "trailer" | "featurette" | "behindTheScenes" | "deletedScene" | "interview" | "scene" | "short" | "clip" | "unknown"

// Shelf order on a detail page.
export const EXTRA_TYPE_ORDER: readonly ExtraType[] = [
	"trailer",
	"featurette",
	"behindTheScenes",
	"deletedScene",
	"interview",
	"scene",
	"short",
	"clip",
	"unknown"
]

// Directory names compared with spaces, dots, underscores and hyphens removed.
const EXTRA_DIRS = new Map<string, ExtraType>([
	["trailers", "trailer"],
	["trailer", "trailer"],
	["featurettes", "featurette"],
	["featurette", "featurette"],
	["behindthescenes", "behindTheScenes"],
	["makingof", "behindTheScenes"],
	["deletedscenes", "deletedScene"],
	["deleted", "deletedScene"],
	["interviews", "interview"],
	["interview", "interview"],
	["scenes", "scene"],
	["shorts", "short"],
	["clips", "clip"],
	["extras", "unknown"],
	["extra", "unknown"],
	["bonus", "unknown"],
	["bonusfeatures", "unknown"],
	["specialfeatures", "unknown"],
	["other", "unknown"],
	["others", "unknown"]
])

const DIR_NAME_NOISE = /[\s._-]+/gu

// Extra type a directory name stands for, or null.
export function extraTypeForDirName(name: string): ExtraType | null {
	return EXTRA_DIRS.get(name.toLowerCase().replace(DIR_NAME_NOISE, "")) ?? null
}

export const EXTRA_SUFFIXES: ReadonlyMap<string, ExtraType> = new Map<string, ExtraType>([
	["trailer", "trailer"],
	["teaser", "trailer"],
	["featurette", "featurette"],
	["behindthescenes", "behindTheScenes"],
	["deleted", "deletedScene"],
	["deletedscene", "deletedScene"],
	["interview", "interview"],
	["scene", "scene"],
	["short", "short"],
	["clip", "clip"],
	["extra", "unknown"],
	["other", "unknown"]
])

// Suffix words as one alternation, longest first so "deletedscene" is tried before "deleted". Letters only, so no
// escaping.
function alternation(words: Iterable<string>): string {
	return Array.from(words)
		.sort((a, b) => b.length - a.length)
		.join("|")
}

// Words that mark a whole stem ("trailer", "trailer2"); words like "clip" or "short" alone are too common for
// personal videos.
const EXTRA_STEM_WORDS: readonly string[] = ["trailer", "teaser", "featurette", "behindthescenes", "deleted", "deletedscene", "interview"]

// "-trailer", " - Featurette 2". Only a hyphen introduces the suffix: dots and underscores separate title words
// ("The.Big.Short").
const EXTRA_SUFFIX = new RegExp(`-\\s*(${alternation(EXTRA_SUFFIXES.keys())})[\\s._-]*\\d*$`, "iu")
const EXTRA_STEM = new RegExp(`^(${alternation(EXTRA_STEM_WORDS)})[\\s._-]*\\d*$`, "iu")

export interface ExtraName {
	type: ExtraType
	// Stem text before the suffix; empty for a bare "trailer.mkv", which belongs to its directory's title.
	owner: string
}

export function parseExtraName(stem: string): ExtraName | null {
	const match = EXTRA_STEM.exec(stem) ?? (stem.includes("-") ? EXTRA_SUFFIX.exec(stem) : null)

	if (match === null) {
		return null
	}

	// Both patterns are built from the map's words, so this only narrows the type.
	const type = EXTRA_SUFFIXES.get((match[1] ?? "").toLowerCase())

	if (type === undefined) {
		return null
	}

	return {
		type,
		// Space before the hyphen is trimmed here: a leading `\s*` in the pattern would rescan long space runs.
		owner: stem.slice(0, match.index).trimEnd()
	}
}
