import type { Node } from "prosemirror-model"
import type { StoryMatch } from "@filen/office/core/docx/edit"
import type { StoryKind } from "@filen/office/core/docx"
import type { PreviewKey } from "@/lib/i18n"
import { outlineSectionEnd, type DocxOutline, type DocxOutlineEntry } from "@filen/office/core/docx/paged"
import type { FindState } from "@/features/preview/components/docxEditorFind.logic"

// Word's Navigation pane (View ▸ Navigation Pane, Ctrl+F): its tabs, the Headings tab's tree (collapsed headings
// hide their subheadings) and drag targets, and the Results tab's text around each match.

export type DocxNavigationTab = "headings" | "pages" | "results"

export interface DocxNavigationState {
	readonly open: boolean
	readonly tab: DocxNavigationTab
	// Bumped to focus the search box again (Ctrl+F with the pane open).
	readonly focus: number
}

export const NAVIGATION_CLOSED: DocxNavigationState = { open: false, tab: "headings", focus: 0 }

// The pane opened: from Ctrl+F (or Find) its search box takes focus; from the View tab it keeps its tab.
export function openedNavigation(previous: DocxNavigationState, search: boolean): DocxNavigationState {
	return { ...previous, open: true, focus: search ? previous.focus + 1 : previous.focus }
}

// The find searched from the pane's box (the find bar stays as it is): the selection's text when given (a new search,
// from the caret), else the last search.
export function seededFind(previous: FindState, seed: string | undefined): FindState {
	return seed === undefined || seed === previous.query ? previous : { ...previous, query: seed, active: -1 }
}

// A heading as the tree shows it.
export interface HeadingRow {
	// The entry's index in the outline.
	readonly index: number
	readonly entry: DocxOutlineEntry
	// The tree's depth (outline levels skipped, a Heading 3 straight under a Heading 1, indent one step).
	readonly depth: number
	// It has subheadings, hidden while it is collapsed.
	readonly parent: boolean
	readonly collapsed: boolean
}

// What keeps a heading collapsed across edits: its level and text, and which of the same it is.
export function headingKeys(entries: readonly DocxOutlineEntry[]): string[] {
	const seen = new Map<string, number>()

	return entries.map(entry => {
		const base = `${String(entry.level)}\u0000${entry.text}`
		const nth = seen.get(base) ?? 0

		seen.set(base, nth + 1)

		return `${base}\u0000${String(nth)}`
	})
}

// The headings shown: each one not inside a collapsed heading, with its depth in the tree.
export function headingRows(outline: DocxOutline, keys: readonly string[], collapsed: ReadonlySet<string>): HeadingRow[] {
	const entries = outline.entries
	const rows: HeadingRow[] = []
	// Levels of the headings the current one is under.
	const stack: number[] = []

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]

		if (entry === undefined) {
			break
		}

		while (stack.length > 0 && (stack[stack.length - 1] ?? 0) >= entry.level) stack.pop()

		const depth = stack.length
		const end = outlineSectionEnd(outline, index)
		const isCollapsed = end > index + 1 && collapsed.has(keys[index] ?? "")

		rows.push({ index, entry, depth, parent: end > index + 1, collapsed: isCollapsed })
		stack.push(entry.level)

		if (isCollapsed) index = end - 1
	}

	return rows
}

// The entry a heading dropped on row `row` goes before: above the row's middle the row's own heading, below it
// the next row's (the end of the document after the last).
export function dropBefore(rows: readonly HeadingRow[], row: number, lowerHalf: boolean, count: number): number {
	const target = lowerHalf ? rows[row + 1] : rows[row]

	return target?.index ?? count
}

// Whether two outlines list the same headings (an outline read before an edit to their text is still right).
export function sameHeadings(a: DocxOutline, b: DocxOutline): boolean {
	if (a === b) return true
	if (a.entries.length !== b.entries.length) return false

	return a.entries.every((entry, index) => {
		const other = b.entries[index]

		return entry.level === other?.level && entry.text === other.text
	})
}

// Characters of context shown on each side of a match.
export const CONTEXT_CHARS = 40

export interface MatchContext {
	readonly before: string
	readonly match: string
	readonly after: string
}

// A match in its paragraph's text, cut to a few words each side (an ellipsis where cut) as Word's Results show it.
export function matchContext(doc: Node, match: StoryMatch, chars = CONTEXT_CHARS): MatchContext {
	const size = doc.content.size
	const from = Math.max(0, Math.min(match.from, size))
	const to = Math.max(from, Math.min(match.to, size))
	const start = doc.resolve(from)
	const end = doc.resolve(to)
	const blockStart = start.parent.isTextblock ? start.start() : from
	const blockEnd = end.parent.isTextblock ? end.end() : to
	let before = doc.textBetween(blockStart, from, " ", " ")
	let after = doc.textBetween(to, blockEnd, " ", " ")

	if (before.length > chars) {
		const cut = before.slice(-chars)
		const space = cut.indexOf(" ")

		before = `…${space > 0 && space < chars / 2 ? cut.slice(space + 1) : cut}`
	}

	if (after.length > chars) {
		const cut = after.slice(0, chars)
		const space = cut.lastIndexOf(" ")

		after = `${space > chars / 2 ? cut.slice(0, space) : cut}…`
	}

	return { before, match: doc.textBetween(from, to, " ", " "), after }
}

const STORY_LABELS: Readonly<Partial<Record<StoryKind, PreviewKey>>> = {
	header: "previewDocxNavigationInHeader",
	footer: "previewDocxNavigationInFooter",
	footnote: "previewDocxNavigationInFootnote",
	endnote: "previewDocxNavigationInEndnote",
	textbox: "previewDocxNavigationInTextBox"
}

// What a result outside the main text is labelled with (where it was found); undefined in the body.
export function storyLabel(kind: StoryKind | undefined): PreviewKey | undefined {
	return kind === undefined ? undefined : STORY_LABELS[kind]
}
