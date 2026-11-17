// The 3D viewer's pure parts: what became of each referenced file, and the animation menu's entries.

export interface ReferenceOutcome {
	readonly path: string
	readonly status: "found" | "missing" | "unreadable" | "refused"
}

// One outcome per path (a loader may ask twice), the first kept.
export function referenceOutcomes(outcomes: readonly ReferenceOutcome[]): ReferenceOutcome[] {
	const seen = new Set<string>()

	return outcomes.filter(outcome => {
		if (seen.has(outcome.path)) return false

		seen.add(outcome.path)

		return true
	})
}

export interface ReferenceSummary {
	readonly missing: readonly string[]
	readonly unreadable: readonly string[]
	readonly refused: readonly string[]
}

function decoded(path: string): string {
	try {
		return decodeURIComponent(path)
	} catch {
		return path
	}
}

// The paths not loaded, as the file names them, by why.
export function referenceSummary(outcomes: readonly ReferenceOutcome[]): ReferenceSummary {
	const pick = (status: ReferenceOutcome["status"]): string[] =>
		outcomes.filter(outcome => outcome.status === status).map(outcome => decoded(outcome.path))

	return { missing: pick("missing"), unreadable: pick("unreadable"), refused: pick("refused") }
}

export interface AnimationEntry {
	readonly key: string
	readonly clip: number
	// Null for a clip without a name.
	readonly name: string | null
}

// Clip names may repeat or be empty: a repeated one is keyed by its occurrence.
export function animationEntries(names: readonly string[]): AnimationEntry[] {
	const seen = new Map<string, number>()

	return names.map((name, clip) => {
		const occurrence = seen.get(name) ?? 0

		seen.set(name, occurrence + 1)

		return { key: `${name}\u0000${String(occurrence)}`, clip, name: name === "" ? null : name }
	})
}
