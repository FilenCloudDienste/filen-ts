import { useSecureStore } from "@/lib/secureStore"
import { type Checklist } from "@filen/utils"

// Per-note, client-side "hide completed checklist items" view preference. Record<noteUuid, boolean>;
// absent → false (show everything). Purely a rendering filter — it never edits the note content, so
// editing while it's on preserves the original (completed items stay in the underlying data, they're
// just not rendered). Persisted via secureStore so it survives restarts and stays in sync between the
// editor-header toggle and the checklist renderer (secureStore is event-driven cross-instance reactive).
export const CHECKLIST_HIDE_COMPLETED_SECURE_STORE_KEY = "notesChecklistHideCompleted"

// Pure filter: the subset of `ids` to render. When hideCompleted is off, returns the SAME array
// reference so a useShallow selector stays render-stable; when on, drops the ids of checked items
// while preserving order. Ids without a matching parsed item are kept (treated as not-completed).
export function visibleChecklistIds(ids: string[], parsed: Checklist, hideCompleted: boolean): string[] {
	if (!hideCompleted) {
		return ids
	}

	const checkedIds = new Set<string>()

	for (const item of parsed) {
		if (item.checked) {
			checkedIds.add(item.id)
		}
	}

	return ids.filter(id => !checkedIds.has(id))
}

// Reactive accessor for the per-note preference. Returns [hideCompleted, toggle]. Used by both the
// editor-header menu toggle and the checklist renderer; secureStore's change events keep the two in
// sync without prop drilling across the header/content boundary.
export function useChecklistHideCompleted(noteUuid: string): [boolean, () => void] {
	const [record, setRecord] = useSecureStore<Record<string, boolean>>(CHECKLIST_HIDE_COMPLETED_SECURE_STORE_KEY, {})

	const hideCompleted = record[noteUuid] ?? false

	const toggle = () => {
		setRecord(prev => ({
			...prev,
			[noteUuid]: !(prev[noteUuid] ?? false)
		}))
	}

	return [hideCompleted, toggle]
}

// ── Ghost row (#80) ──────────────────────────────────────────────────────────
//
// With "hide completed" on and EVERY item checked, the filter renders zero rows — and every
// editing entry point hangs off a rendered row's input, so the checklist became impossible to
// edit or extend. The fix renders one GHOST row: a normal-looking empty row that exists only in
// the UI (never in `parsed`, never serialized) until the user types into it, at which point it
// materializes into a real appended item. Ghosts also cover the LIVE trap: checking off the last
// visible item makes the ghost appear in the same commit.

/**
 * Whether the ghost row is the rendered surface. `hasItems` keeps the pre-hydration mount frame
 * (store still empty) from flashing a ghost before the initial-value effect seeds the store; a
 * truly empty note is seeded with a real empty row by that effect instead.
 */
export function isChecklistGhostActive(hasItems: boolean, visibleCount: number, hideCompleted: boolean, readOnly: boolean): boolean {
	return hideCompleted && !readOnly && hasItems && visibleCount === 0
}

/**
 * PURE ghost-id derivation: `mountSeed` (random per checklist mount) plus the count of
 * previously-materialized ghosts still present in `parsed`. Properties the component relies on:
 *   - stable while the trap is active (count unchanged → same id → stable React key);
 *   - materializing consumes the id (count +1) — the NEXT trap activation derives a fresh one
 *     (e.g. the materialized row got checked off);
 *   - backspacing a materialized ghost away REUSES its id (count back down) — the re-rendered
 *     ghost keeps the same React key, so the focused TextInput instance survives the round trip
 *     and the keyboard never drops.
 * Parser-generated ids are uuids; the `-ghost-` infix cannot collide with them.
 */
export function checklistGhostRowId(mountSeed: string, parsed: Checklist): string {
	let materialized = 0

	for (const item of parsed) {
		if (item.id.startsWith(`${mountSeed}-ghost-`)) {
			materialized++
		}
	}

	return `${mountSeed}-ghost-${materialized}`
}
