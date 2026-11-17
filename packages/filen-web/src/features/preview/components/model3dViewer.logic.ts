import type { ReferenceResolver } from "@/features/preview/lib/referenceResolver"
import { nameKey, referenceSegments } from "@/features/preview/lib/referenceResolver.logic"

// The 3D viewer's pure parts: how the worker's references are served and what became of each, and the animation menu's
// entries.

// Distinct files a model may reference; the rest are not looked up.
export const MAX_REFERENCES = 256
// Paths of each kind the information panel lists before it counts the rest.
export const PANEL_REFERENCES = 50

export interface ReferenceOutcome {
	readonly path: string
	readonly status: "found" | "missing" | "unreadable" | "refused"
}

// Serves the worker's references through the surface's resolver: each distinct file (by its normalised path) looked up
// and read once however often the model names it, at most MAX_REFERENCES of them, every file within what the model
// left of the cap. Each outcome is recorded for the information panel.
export function referenceServer(
	resolver: ReferenceResolver | null,
	budget: number,
	signal: AbortSignal,
	record: (outcome: ReferenceOutcome) => void
): (path: string) => Promise<Blob | null> {
	const served = new Map<string, Promise<Blob | null>>()
	let left = budget

	const serve = async (path: string): Promise<Blob | null> => {
		const found =
			resolver === null ? ({ status: "missing" } as const) : await resolver(path).catch(() => ({ status: "missing" }) as const)

		if (found.status !== "found") {
			record({ path, status: found.status })

			return null
		}

		if (found.size > left) {
			record({ path, status: "refused" })

			return null
		}

		// Held against the cap while it reads: references read together cannot all pass.
		left -= found.size

		const bytes = await found.read(found.size, signal).catch(() => null)

		if (bytes === null) {
			left += found.size
			record({ path, status: "missing" })

			return null
		}

		record({ path, status: "found" })

		return new Blob([bytes as Uint8Array<ArrayBuffer>])
	}

	return path => {
		const segments = referenceSegments(path)
		const key = segments === null ? path : segments.map(nameKey).join("/")
		const known = served.get(key)

		if (known !== undefined) return known

		if (served.size >= MAX_REFERENCES) {
			record({ path, status: "refused" })

			return Promise.resolve(null)
		}

		const serving = serve(path)

		served.set(key, serving)

		return serving
	}
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
