import { checklistParser, type Checklist } from "@filen/shared"

// Canonical serialization — the `<ul data-checked>` HTML every client stores. Consecutive rows sharing
// a checked state group under one <ul> (checklistParser.stringify); an empty list serializes to "".
export function serializeChecklist(rows: Checklist): string {
	return checklistParser.stringify(rows)
}

// "Hide completed items": the RENDER-only subset of rows (checked rows dropped, order preserved) when
// the preference is on. Never mutates `rows` and never touches the underlying serialized content —
// every edit handler in the component keeps looking up by id against the FULL list, so toggling this
// preference off always restores exactly what was there before.
export function visibleChecklistRows(rows: Checklist, hideCompleted: boolean): Checklist {
	return hideCompleted ? rows.filter(row => !row.checked) : rows
}
