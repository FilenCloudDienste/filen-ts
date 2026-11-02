import type { SlideReview } from "../../../core/presentation/comments"
import type { DeckOp } from "../../../core/presentation/edit/ops"
import type { ShapeRef, SlideRef } from "../../../core/presentation/model"
import type { EngineSession } from "../engine"

// Notes a save took back before its snapshot (started, nothing typed in them), while the page's editor may still be
// on them: the review keeps answering their body (empty), and the first thing the editor sends for it (a layout, a
// seed, a text) makes them again from the same op (same refs and part), so a keystroke racing the save is never lost.
// `origin`: the revision the page was answered when it started them (what its retract names).

export interface DormantNotes {
	readonly slide: SlideRef
	readonly op: DeckOp
	readonly notes: ShapeRef
	readonly box: SlideReview["notesBox"]
	readonly origin: number
}

const DORMANT = new WeakMap<EngineSession, Map<SlideRef, DormantNotes>>()

export function dormantNotes(session: EngineSession, slide: SlideRef): DormantNotes | undefined {
	return DORMANT.get(session)?.get(slide)
}

// The dormant notes whose body is `notes` (a ref the page's editor names).
export function dormantNotesOfBody(session: EngineSession, notes: SlideRef): DormantNotes | undefined {
	for (const entry of DORMANT.get(session)?.values() ?? []) if (entry.notes.slide === notes) return entry

	return undefined
}

export function dormantNotesOfOrigin(session: EngineSession, origin: number): DormantNotes | undefined {
	for (const entry of DORMANT.get(session)?.values() ?? []) if (entry.origin === origin) return entry

	return undefined
}

export function setDormantNotes(session: EngineSession, entry: DormantNotes): void {
	let map = DORMANT.get(session)

	if (map === undefined) {
		map = new Map()
		DORMANT.set(session, map)
	}

	map.set(entry.slide, entry)
}

export function clearDormantNotes(session: EngineSession, slide: SlideRef): void {
	DORMANT.get(session)?.delete(slide)
}
