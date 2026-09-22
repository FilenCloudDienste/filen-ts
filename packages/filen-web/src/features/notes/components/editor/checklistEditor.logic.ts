import { checklistParser, type Checklist } from "@filen/shared"

// Parse the note HTML into rows, falling back to a single empty unchecked row when the content is empty
// or unparseable (mobile parity: checklistParser.parse returns [] for malformed HTML, and a brand-new
// checklist note starts as one editable row). `newId` is injected so the component supplies its own
// id source and the fallback stays deterministic in tests.
export function parseChecklistSeed(seed: string, newId: () => string): Checklist {
	const parsed = seed.length > 0 ? checklistParser.parse(seed) : []

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
	return checklistParser.stringify(rows)
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

// "Hide completed items": the RENDER-only subset of rows (checked rows dropped, order preserved) when
// the preference is on. Never mutates `rows` and never touches the underlying serialized content —
// every edit handler in the component keeps looking up by id against the FULL list, so toggling this
// preference off always restores exactly what was there before.
export function visibleChecklistRows(rows: Checklist, hideCompleted: boolean): Checklist {
	return hideCompleted ? rows.filter(row => !row.checked) : rows
}
