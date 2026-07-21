import { type Checklist } from "@filen/utils"

// Pure checklist mutation transforms shared by the checklist Item component. They compute the next
// `parsed` list (and which row to focus) WITHOUT touching the store, so the component can: apply the
// result via setParsed/setIds, focus the returned row, and — crucially — propagate the change to the
// parent onChange (stringified) so the edit is actually synced/persisted. Keeping them pure makes the
// add/delete-then-sync behaviour unit-testable without rendering the React Native tree.

export type ChecklistEditResult = {
	// Whether the list content actually changed. When false the component must NOT call onChange
	// (no sync needed) and may skip the store write — it only needs to move focus.
	changed: boolean
	// The next list when `changed` is true; the unchanged input list otherwise.
	next: Checklist
	// The id of the row to focus after applying, or null when focus should not move.
	focusId: string | null
}

// Backspace on an empty row. Mirrors the component's previous inline logic:
//   - a single remaining item resets to one fresh empty row (`newId`), with no focus move
//   - the first row (index 0) and unknown ids are no-ops
//   - any other row is removed and focus moves to the previous row
export function removeChecklistItem(parsed: Checklist, itemId: string, newId: string): ChecklistEditResult {
	if (parsed.length === 1) {
		return {
			changed: true,
			next: [
				{
					id: newId,
					checked: false,
					content: ""
				}
			],
			focusId: null
		}
	}

	const index = parsed.findIndex(i => i.id === itemId)

	if (index === -1 || index === 0) {
		return {
			changed: false,
			next: parsed,
			focusId: null
		}
	}

	const prevItem = parsed[index - 1]

	return {
		changed: true,
		next: parsed.filter(i => i.id !== itemId),
		focusId: prevItem ? prevItem.id : null
	}
}

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

// Enter on a non-empty row. Mirrors the component's previous inline logic:
//   - if the next row already exists and is empty, reuse it (focus it) instead of inserting another
//   - otherwise insert a fresh empty row (`newId`) right after `afterId` and focus it
export function addChecklistLine(parsed: Checklist, afterId: string, newId: string): ChecklistEditResult {
	const afterIndex = parsed.findIndex(i => i.id === afterId)
	const nextIndex = afterIndex + 1
	const nextItem = afterIndex >= 0 ? parsed[nextIndex] : undefined

	if (nextItem && nextItem.content.trim().length === 0) {
		return {
			changed: false,
			next: parsed,
			focusId: nextItem.id
		}
	}

	const newList = [...parsed]

	newList.splice(nextIndex, 0, {
		id: newId,
		checked: false,
		content: ""
	})

	return {
		changed: true,
		next: newList,
		focusId: newId
	}
}
