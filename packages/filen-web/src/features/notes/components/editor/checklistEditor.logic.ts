import { checklistParser, type Checklist } from "@filen/shared"

// checklistParser.stringify interpolates row text raw into `<li>…</li>`, and its parser reads the row
// back via `rawText` WITHOUT decoding entities. So the only way tag-like row text ("Fix <Header>", a
// literal `</li><li>`, a bare `&`) survives the serialize→persist→parse round-trip is to HTML-escape it
// on the way out and reverse that escape on the way in — done here at the web boundary rather than in
// the shared @filen/shared parser so this app owns its own encoding without changing behavior for other
// clients. escape/unescape are exact inverses (escape does `&` first, unescape does `&` last), which
// makes the round-trip lossless even for text that itself contains these entities (a literally typed
// `&lt;` escapes to `&amp;lt;` and comes back as `&lt;`).
function escapeChecklistText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function unescapeChecklistText(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
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
