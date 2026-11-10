import { formatChord, parseCombo } from "@filen/shared/keymap"
import { currentCatalog } from "@/lib/keymap/actions"
import { conflictingActions, reassignChanges, swapChanges } from "@/lib/keymap/conflicts"
import { reservedBlocks, reservedOwner } from "@/lib/keymap/reserved"
import {
	CURRENT_PLATFORM,
	currentKeymapRecord,
	currentRecording,
	currentRecordingProblem,
	dismissRecordingProblem,
	endRecording,
	noteRecordingProblem,
	reportRecordingProblem,
	updateOverrides,
	type KeymapPlatform
} from "@/lib/keymap/registry"

// A combo's chords in their canonical spelling, in order.
export function comboChords(combo: string): string[] {
	return parseCombo(combo).map(formatChord)
}

// `combo` with `chord` added (slot null) or in place of the chord at `slot`; a chord it already has is not doubled.
export function withChord(combo: string, chord: string, slot: number | null): string {
	const chords = comboChords(combo)

	if (slot === null || slot >= chords.length) {
		chords.push(chord)
	} else {
		chords[slot] = chord
	}

	return [...new Set(chords)].join(",")
}

// `combo` without the chord at `slot`.
export function withoutChord(combo: string, slot: number): string {
	return comboChords(combo)
		.filter((_, index) => index !== slot)
		.join(",")
}

export type CommitOutcome = "saved" | "conflict" | "blocked" | "unchanged"

// What a recorded chord does to the action `owner` is recording: saved (with a note when a browser or the system may
// keep the key), held back for the user to resolve a conflict, or refused where the desktop app's shell takes the key.
export async function commitRecordedChord(
	owner: string,
	chord: string,
	platform: KeymapPlatform = CURRENT_PLATFORM
): Promise<CommitOutcome> {
	const session = currentRecording()

	if (session?.owner !== owner || session.actionId === null) {
		return "unchanged"
	}

	const { actionId, slot } = session
	const catalog = currentCatalog(currentKeymapRecord())
	const action = catalog.byId.get(actionId)

	if (action === undefined) {
		endRecording(owner)

		return "unchanged"
	}

	const [parsed] = parseCombo(chord)
	const owned = parsed === undefined ? undefined : reservedOwner(parsed, platform)

	if (owned !== undefined && reservedBlocks(owned, platform)) {
		reportRecordingProblem(owner, { kind: "reserved", actionId, chord, owner: owned, blocked: true })

		return "blocked"
	}

	const combo = withChord(action.combo, chord, slot)
	const conflicts = conflictingActions(catalog.actions, chord, actionId, platform.mac)

	if (conflicts.length > 0) {
		reportRecordingProblem(owner, {
			kind: "conflict",
			actionId,
			combo,
			chord,
			replaced: slot === null ? null : (comboChords(action.combo)[slot] ?? null),
			conflictIds: conflicts.map(other => other.id)
		})

		return "conflict"
	}

	endRecording(owner)

	if (combo === action.combo) {
		return "unchanged"
	}

	await updateOverrides({ [actionId]: combo })

	if (owned !== undefined) {
		noteRecordingProblem({ kind: "reserved", actionId, chord, owner: owned, blocked: false })
	}

	return "saved"
}

// Settles the conflict the last recording left: "reassign" keeps the chord here and takes it off every action that
// had it, "swap" gives the one other action the chord this one gave up. One write either way.
export async function resolveRecordingConflict(
	resolution: "reassign" | "swap",
	platform: KeymapPlatform = CURRENT_PLATFORM
): Promise<void> {
	const problem = currentRecordingProblem()

	if (problem?.kind !== "conflict") {
		return
	}

	const { actions } = currentCatalog(currentKeymapRecord())
	const [other] = problem.conflictIds
	const changes =
		resolution === "swap" && problem.replaced !== null && other !== undefined && problem.conflictIds.length === 1
			? swapChanges(actions, problem.actionId, problem.combo, problem.chord, problem.replaced, other, platform.mac)
			: reassignChanges(actions, problem.actionId, problem.combo, problem.chord, platform.mac)

	dismissRecordingProblem()
	await updateOverrides(changes)
}
