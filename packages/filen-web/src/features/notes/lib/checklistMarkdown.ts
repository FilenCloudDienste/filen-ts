import { checklistParser } from "@filen/shared"

// Apart from export.logic.ts, which loads the DOM sanitizer: plain-text extraction (notePlainText) runs where no
// document exists.

// Checklist -> markdown task lines, preserving order and checked state exactly. checklistParser.parse
// already flattens every `<ul data-checked>` run in document order (including multiple runs of the
// same checked state — mobile/old-web's own "multi-run" shape), so no re-grouping is needed here; an
// item with empty content still emits its own line (`- [ ] ` / `- [x] `, no trailing text) rather
// than being dropped, matching the editor's own empty-row-is-valid rule (checklistEditor.logic.ts).
export function checklistToMarkdownLines(html: string): string[] {
	return checklistParser.parse(html).map(item => `- [${item.checked ? "x" : " "}] ${item.content}`)
}

export function checklistToMarkdown(html: string): string {
	return checklistToMarkdownLines(html).join("\n")
}
