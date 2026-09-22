import { type Checklist, type ChecklistEditResult } from "@filen/shared"

// First keystroke into the ghost row (#80): the ghost becomes a REAL item, appended at the END
// of the list (after the hidden checked items — consecutive adds then chain like Enter does).
// Appending under the ghost's own id is what preserves the focused input across the
// materialization (same React key, same TextInput instance). No-op if the id already exists
// (a duplicate keystroke race must not double-append).
export function materializeChecklistGhost(parsed: Checklist, ghostId: string, content: string): ChecklistEditResult {
	if (parsed.some(i => i.id === ghostId)) {
		return {
			changed: false,
			next: parsed,
			focusId: null
		}
	}

	return {
		changed: true,
		next: [
			...parsed,
			{
				id: ghostId,
				checked: false,
				content
			}
		],
		focusId: null
	}
}
