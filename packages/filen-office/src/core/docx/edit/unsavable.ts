import { FEATURE_HANDLERS } from "./handlers/index"
import type { DocxEditorSession } from "./session"

// Decision 5 at save time: when the writer refuses an edited document (its own checks failed), the edited
// units it cannot write are found, and the save writes them as they were last saved (DocxEditorSession
// .withReverted; .revert once the file is stored). `writes` tries the writer on stand-in sessions without
// storing anything. A unit is a block of a story, or what a feature registers (a comment, a note, a
// section's properties): only the failing unit goes back, the rest saves.

// One kind of revertible unit. Keys are the kind's own (block positions in the session's document).
export interface RevertibleUnits {
	readonly kind: string
	// Units of `session` changed since the last save that can go back to their last-saved form.
	edited(session: DocxEditorSession): readonly number[]
	// A read-only stand-in for `session` with `keys` back at their last-saved form.
	withReverted(session: DocxEditorSession, keys: readonly number[]): DocxEditorSession
	// Takes them back in `session` itself, as one undoable step; the number taken back.
	revert(session: DocxEditorSession, keys: readonly number[]): number
}

export interface RevertibleUnit {
	readonly kind: string
	readonly key: number
}

const BLOCKS: RevertibleUnits = {
	kind: "block",
	edited: session => session.editedBlocks(),
	withReverted: (session, keys) => session.withReverted(keys),
	revert: (session, keys) => {
		const doc = session.state.doc

		return session.revert(keys.map(pos => doc.nodeAt(pos)).filter(node => node !== null))
	}
}

// Blocks first, then each feature's units: the order stand-ins apply them in (block keys are positions in the
// session's own document; a feature's keys are found again in whatever document it is given).
export const REVERTIBLE_UNITS: readonly RevertibleUnits[] = [BLOCKS, ...FEATURE_HANDLERS.flatMap(feature => feature.units ?? [])]

export interface UnsavableBlocks {
	readonly session: DocxEditorSession
	// Every unit to take back, blocks included: what a stand-in and a revert must take (withRevertedUnits).
	readonly units: readonly RevertibleUnit[]
}

// A stand-in for `session` with `units` back at their last-saved form.
export function withRevertedUnits(session: DocxEditorSession, units: readonly RevertibleUnit[]): DocxEditorSession {
	let out = session

	for (const kind of REVERTIBLE_UNITS) {
		const keys = units.filter(unit => unit.kind === kind.kind).map(unit => unit.key)

		if (keys.length > 0) out = kind.withReverted(out, keys)
	}

	return out
}

// The block positions among `units` (keys in the session's own document).
export function blockPositions(units: readonly RevertibleUnit[]): number[] {
	return units.filter(unit => unit.kind === BLOCKS.kind).map(unit => unit.key)
}

// Takes the feature units among `units` back in `session` itself, each kind as its own undoable step; the number
// taken back. Blocks are left to the caller (block keys are positions, which move as the document is edited).
export function revertFeatureUnits(session: DocxEditorSession, units: readonly RevertibleUnit[]): number {
	let count = 0

	for (const kind of REVERTIBLE_UNITS.slice(1)) {
		const keys = units.filter(unit => unit.kind === kind.kind).map(unit => unit.key)

		if (keys.length > 0) count += kind.revert(session, keys)
	}

	return count
}

export interface UnsavableSearchOptions {
	// Writer runs at most (each writes the whole document); default 24.
	readonly maxAttempts?: number
	// Time the search may take (ms, from its start); default 20 s.
	readonly budgetMs?: number
	readonly now?: () => number
	// Between runs: the page's turn (input, painting).
	readonly pause?: () => Promise<void>
	// Before each run, with the number of runs so far.
	readonly onAttempt?: (attempt: number) => void
	// The writer is known to refuse the sessions as they are (it just did, for this reason): not tried again.
	readonly refused?: boolean
}

interface Candidate {
	readonly session: number
	readonly unit: RevertibleUnit
}

class SearchExhausted extends Error {}

// The edited blocks to take back so that the writer accepts the document: a small set, found by halving the
// edited blocks. Null when taking edited blocks back does not help (the refusal is not about one of them),
// or the search ran out of runs or time; the caller then keeps the document as it is.
export async function findUnsavableBlocks(
	sessions: readonly DocxEditorSession[],
	writes: (sessions: readonly DocxEditorSession[]) => Promise<boolean>,
	options: UnsavableSearchOptions = {}
): Promise<UnsavableBlocks[] | null> {
	const maxAttempts = options.maxAttempts ?? 24
	const budget = options.budgetMs ?? 20_000
	const now = options.now ?? (() => Date.now())
	const started = now()
	const all: Candidate[] = sessions.flatMap((session, index) =>
		session.readOnly
			? []
			: // Feature units listed first: the search prefers the finer units (one comment rather than the block
				// holding its anchor), so only the failing unit goes back.
				[...REVERTIBLE_UNITS.slice(1), BLOCKS].flatMap(units =>
					units.edited(session).map(key => ({ session: index, unit: { kind: units.kind, key } }))
				)
	)
	let attempts = 0

	if (all.length === 0) return null

	const passes = async (reverted: readonly Candidate[]): Promise<boolean> => {
		if (attempts >= maxAttempts || (attempts > 0 && now() - started > budget)) throw new SearchExhausted()

		if (attempts > 0) await options.pause?.()

		options.onAttempt?.(attempts)
		attempts++

		return writes(
			sessions.map((session, index) => {
				const units = reverted.filter(candidate => candidate.session === index).map(candidate => candidate.unit)

				return units.length === 0 ? session : withRevertedUnits(session, units)
			})
		)
	}

	// Blocks of `candidates` that must go back, given that taking back `base` and all of `candidates` passes and
	// `base` alone does not.
	const search = async (candidates: readonly Candidate[], base: readonly Candidate[]): Promise<Candidate[]> => {
		if (candidates.length === 1) return [...candidates]

		const half = candidates.length >> 1
		const a = candidates.slice(0, half)
		const b = candidates.slice(half)

		if (await passes([...base, ...a])) return search(a, base)
		if (await passes([...base, ...b])) return search(b, base)

		const fromA = await search(a, [...base, ...b])

		return [...fromA, ...(await search(b, [...base, ...fromA]))]
	}

	try {
		// Refused for something else (the zip, a part no edit made), or not even with every edited block back.
		if ((options.refused !== true && (await passes([]))) || !(await passes(all))) return null

		const found = await search(all, [])

		return sessions
			.map((session, index) => {
				const units = found.filter(candidate => candidate.session === index).map(candidate => candidate.unit)

				return { session, units }
			})
			.filter(entry => entry.units.length > 0)
	} catch (error) {
		if (error instanceof SearchExhausted) return null

		throw error
	}
}
