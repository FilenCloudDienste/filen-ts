import type { NoteType } from "@filen/sdk-rs"
import { extensionOf, codeMirrorSupportedExtensions } from "@/features/drive/lib/preview.logic"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"

// Pure detection/sanitize helpers for note import (the widened symmetric counterpart of
// export.logic.ts): given a chosen file's name, decide which note type it seeds, and — for the one
// type whose raw bytes can carry markup — re-sanitize before it ever reaches the note content field.
// No File/FileReader here (kept DOM-I/O-free and unit-testable); the impure shell lives in import.ts.

// Extensions the widened import recognizes, checked BEFORE the generic code-extension fallback below:
// txt -> text, md/markdown -> md, html/htm/html5 -> rich. These three overlap with entries
// codeMirrorSupportedExtensions() also recognizes (md and html both have a CodeMirror grammar), so the
// order here is load-bearing — an imported "notes.md" must become an md note, never a "code" note.
const TEXT_EXTENSIONS = new Set(["txt"])
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"])
const RICH_EXTENSIONS = new Set(["html", "htm", "html5"])

// Detects the note type a file seeds, purely from its extension — undefined for anything unrecognized
// (the caller surfaces an error rather than guessing). Checklist is deliberately never auto-detected:
// reverse-engineering task-list markdown into a checklist would be lossy/ambiguous, so a checklist-shaped
// .md import becomes a plain md note instead, exactly like export's own checklist -> .md is one-directional.
export function detectImportNoteType(filename: string): NoteType | undefined {
	const ext = extensionOf(filename)

	if (TEXT_EXTENSIONS.has(ext)) {
		return "text"
	}

	if (MARKDOWN_EXTENSIONS.has(ext)) {
		return "md"
	}

	if (RICH_EXTENSIONS.has(ext)) {
		return "rich"
	}

	if (ext.length > 0 && codeMirrorSupportedExtensions().includes(ext)) {
		return "code"
	}

	return undefined
}

// The file input's `accept` attribute: the union of every extension detectImportNoteType recognizes,
// deduplicated (md/markdown and html/htm/html5 already cover their own group; the code branch pulls
// straight from the shared CodeMirror language map so a future language addition widens import too).
export function importAcceptAttribute(): string {
	const extensions = new Set<string>([...TEXT_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...RICH_EXTENSIONS, ...codeMirrorSupportedExtensions()])

	return [...extensions].map(ext => `.${ext}`).join(",")
}

// A file's raw text, sanitized for the DETECTED type: rich re-sanitizes through the SAME allowlist the
// live editor/reader/export path uses — a file's HTML is never trusted just because the user picked it
// themselves (it could be a downloaded/forwarded file with a stale or hand-edited body). Every other
// type is a byte-faithful passthrough, mirroring export's own text/md/code branches.
export function sanitizeImportedContent(noteType: NoteType, rawText: string): string {
	return noteType === "rich" ? sanitizeRichTextHtml(rawText) : rawText
}

// The new note's title, seeded from the file name with its extension stripped — falls back to the
// whole file name when it carries none (extensionOf's own "no real extension" case, e.g. a dotfile).
export function titleFromFilename(filename: string): string {
	const ext = extensionOf(filename)

	return ext.length > 0 ? filename.slice(0, filename.length - ext.length - 1) : filename
}
