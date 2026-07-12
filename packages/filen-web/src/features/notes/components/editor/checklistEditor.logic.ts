import { checklistParser, type Checklist } from "@filen/utils"

// checklistParser.stringify interpolates row text raw into `<li>…</li>`, and its parser reads the row
// back via `rawText` WITHOUT decoding entities. So the only way tag-like row text ("Fix <Header>", a
// literal `</li><li>`, a bare `&`) survives the serialize→persist→parse round-trip is to HTML-escape it
// on the way out and reverse that escape on the way in — done here at the web boundary rather than in
// the shared @filen/utils parser so this app owns its own encoding without changing behavior for other
// clients. escape/unescape are exact inverses (escape does `&` first, unescape does `&` last), which
// makes the round-trip lossless even for text that itself contains these entities (a literally typed
// `&lt;` escapes to `&amp;lt;` and comes back as `&lt;`).
function escapeChecklistText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function unescapeChecklistText(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

// Pure checklist mutation transforms for the custom checklist editor — ported from mobile's
// checklistEdit.ts. They compute the next list (and which row to focus) WITHOUT touching React state, so
// the component applies the result, moves focus, and serializes through the SAME @filen/utils
// checklistParser both mobile and old-web write. Keeping them pure makes the
// add/remove/toggle → serialize round-trip unit-testable without rendering.

export interface ChecklistEditResult {
	// Whether the list content actually changed. When false the caller must NOT serialize/enqueue (no
	// edit happened) and only needs to move focus.
	changed: boolean
	// The next list when `changed` is true; the unchanged input list otherwise.
	next: Checklist
	// The id of the row to focus after applying, or null when focus should not move.
	focusId: string | null
}

// Parse the note HTML into rows, falling back to a single empty unchecked row when the content is empty
// or unparseable (mobile parity: checklistParser.parse returns [] for malformed HTML, and a brand-new
// checklist note starts as one editable row). `newId` is injected so the component supplies its own
// id source and the fallback stays deterministic in tests.
export function parseChecklistSeed(seed: string, newId: () => string): Checklist {
	const parsed = (seed.length > 0 ? checklistParser.parse(seed) : []).map(row => ({
		...row,
		content: unescapeChecklistText(row.content)
	}))

	if (parsed.length === 0) {
		return [
			{
				id: newId(),
				checked: false,
				content: ""
			}
		]
	}

	return parsed
}

// Canonical serialization — the `<ul data-checked>` HTML every client stores. Consecutive rows sharing
// a checked state group under one <ul> (checklistParser.stringify); an empty list serializes to "".
export function serializeChecklist(rows: Checklist): string {
	return checklistParser.stringify(rows.map(row => ({ ...row, content: escapeChecklistText(row.content) })))
}

// Backspace on an empty row (mobile removeChecklistItem):
//   - a single remaining item resets to one fresh empty row (`newId`), with no focus move
//   - the first row (index 0) and unknown ids are no-ops
//   - any other row is removed and focus moves to the previous row
export function removeChecklistItem(rows: Checklist, itemId: string, newId: string): ChecklistEditResult {
	if (rows.length === 1) {
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

	const index = rows.findIndex(i => i.id === itemId)

	if (index === -1 || index === 0) {
		return {
			changed: false,
			next: rows,
			focusId: null
		}
	}

	const prevItem = rows[index - 1]

	return {
		changed: true,
		next: rows.filter(i => i.id !== itemId),
		focusId: prevItem ? prevItem.id : null
	}
}

// Enter on a non-empty row (mobile addChecklistLine):
//   - if the next row already exists and is empty, reuse it (focus it) instead of inserting another
//   - otherwise insert a fresh empty row (`newId`) right after `afterId` and focus it
export function addChecklistLine(rows: Checklist, afterId: string, newId: string): ChecklistEditResult {
	const afterIndex = rows.findIndex(i => i.id === afterId)
	const nextIndex = afterIndex + 1
	const nextItem = afterIndex >= 0 ? rows[nextIndex] : undefined

	if (nextItem?.content.trim().length === 0) {
		return {
			changed: false,
			next: rows,
			focusId: nextItem.id
		}
	}

	const newList = [...rows]

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

// Toggle a row's checked state, returning a new list (never mutating the input).
export function toggleChecklistItem(rows: Checklist, itemId: string, checked: boolean): Checklist {
	return rows.map(i =>
		i.id === itemId
			? {
					...i,
					checked
				}
			: i
	)
}

// Set a row's text content, returning a new list.
export function setChecklistItemContent(rows: Checklist, itemId: string, content: string): Checklist {
	return rows.map(i =>
		i.id === itemId
			? {
					...i,
					content
				}
			: i
	)
}
