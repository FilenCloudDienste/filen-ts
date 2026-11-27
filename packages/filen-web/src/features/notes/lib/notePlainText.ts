import type { Note } from "@filen/sdk-rs"
import { checklistToMarkdown } from "@/features/notes/lib/checklistMarkdown"

// Block breaks become line breaks, then the markup goes: what the reader would show, as plain text.
function richTextToPlain(html: string): string {
	const marked = html.replace(/<\/(p|li|h[1-6]|div|blockquote|pre)>|<br\s*\/?>/gi, "$&\n")

	return new DOMParser()
		.parseFromString(marked, "text/html")
		.body.textContent.replace(/\n{3,}/g, "\n\n")
		.trim()
}

// A note's content as plain text, by its type.
export function notePlainText(note: Pick<Note, "noteType">, content: string): string {
	switch (note.noteType) {
		case "rich":
			return richTextToPlain(content)
		case "checklist":
			return checklistToMarkdown(content)
		case "text":
		case "md":
		case "code":
			return content
	}
}
