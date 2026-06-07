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
