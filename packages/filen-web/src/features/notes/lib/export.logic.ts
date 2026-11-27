import { extensionStart } from "@filen/shared"
import { checklistToMarkdown } from "@/features/notes/lib/checklistMarkdown"
import type { NoteType } from "@filen/sdk-rs"
import { extensionOf, codeMirrorLanguageFor } from "@/features/drive/lib/preview.logic"
import { sanitizeRichTextHtml } from "@/features/notes/lib/sanitizeRichText"
import { sanitizeFilename } from "@/lib/filename"

// Pure per-type export transforms (FAITHFUL formats, not old-web's lossy always-.txt). Kept
// free of the SDK/i18n/DOM so the whole table is testable with plain strings; export.ts is the thin
// impure shell that fetches content and triggers the actual browser download.

// The extension a note's exported file gets, BEFORE the "does the title already end with it" check
// below. md/checklist -> .md (checklist's canonical HTML round-trips through markdown task lines,
// see checklistToMarkdown), rich -> .html (sanitized first), text -> .txt. code is the one
// conditional case: a title already carrying an extension the CM editor would actually highlight
// (codeMirrorTagForNote's own map, reader.logic.ts) keeps THAT extension untouched instead of
// forcing .txt onto it — e.g. "script.py" exports as "script.py", not "script.py.txt". A code title
// with an unrecognized/absent extension (including CODE_EXTENSIONS entries with no CodeMirror
// grammar, like "Makefile" or "readme.mk") still falls back to .txt: this reuses the LANGUAGE map
// only, per spec, not the broader "is this extension code-ish at all" set.
function targetExtension(noteType: NoteType, sanitizedBase: string): string {
	switch (noteType) {
		case "md":
		case "checklist":
			return "md"
		case "rich":
			return "html"
		case "code": {
			const ext = extensionOf(sanitizedBase)

			return ext !== "" && codeMirrorLanguageFor(ext) !== "" ? ext : "txt"
		}
		case "text":
			return "txt"
	}
}

// Faithful export file name: sanitized title (falling back to `fallbackTitle`, the caller's own
// translated "Untitled note"), with the type's target extension appended only when the sanitized
// title doesn't already end with it (case-insensitively) — a code note whose title IS its own
// extension (the case above) never gets a redundant second one.
export function exportFilename(title: string | undefined, noteType: NoteType, fallbackTitle: string): string {
	const trimmed = (title ?? "").trim()
	const base = sanitizeFilename(trimmed.length > 0 ? trimmed : fallbackTitle)
	const ext = targetExtension(noteType, base)
	const suffix = `.${ext}`

	return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`
}

// The exported file's actual bytes for a note's raw content, by type. text/md/code are byte-faithful
// passthroughs (no lossy re-encoding); rich is sanitized through the SAME allowlist the live
// editor/reader use (sanitizeRichText.ts) before ever leaving the app, so participant-authored HTML
// on a shared note can't carry a script tag into a file on disk; checklist becomes its markdown task
// lines. Content that failed to load (getNoteContent returned undefined) is the caller's concern —
// this only ever sees a resolved string.
export function exportContent(noteType: NoteType, rawContent: string): string {
	switch (noteType) {
		case "rich":
			return sanitizeRichTextHtml(rawContent)
		case "checklist":
			return checklistToMarkdown(rawContent)
		case "text":
		case "md":
		case "code":
			return rawContent
	}
}

// Blob MIME type for a resolved export file name's own extension — matches exportFilename's target
// extension 1:1 (including the code-note "keeps its own extension" case, which falls through to the
// generic text/plain branch same as .txt: there is no per-language MIME table here, and the browser
// download itself doesn't render this inline anyway).
export function exportMimeType(filename: string): string {
	const ext = extensionOf(filename)

	if (ext === "md") {
		return "text/markdown"
	}

	if (ext === "html") {
		return "text/html"
	}

	return "text/plain"
}

// name -> deduplicated name, suffixing " (2)", " (3)", ... BEFORE the extension on every repeat past
// the first (Finder/Explorer's own convention) — used by exportAllNotes so two notes that faithfully
// export to the identical file name (same sanitized title + type) don't silently clobber each other
// inside the zip. Every EMITTED name is reserved under its NFC + lower-cased key, and every name (first
// occurrences included) is checked against it: a generated "Foo (2)" never collides with a real note
// titled "Foo (2)", and "Todo" / "todo" stay apart after extraction on case-insensitive file systems.
// Order-preserving and pure: same input array always yields the same output array.
export function dedupeExportNames(names: readonly string[]): string[] {
	const emitted = new Set<string>()
	// Next suffix to try per original key, so a long run of one name stays linear.
	const nextSuffix = new Map<string, number>()

	return names.map(name => {
		const key = name.normalize("NFC").toLowerCase()

		if (!emitted.has(key)) {
			emitted.add(key)

			return name
		}

		const dot = extensionStart(name)
		const base = dot === -1 ? name : name.slice(0, dot)
		const ext = dot === -1 ? "" : name.slice(dot)
		let suffix = nextSuffix.get(key) ?? 2
		let candidate = `${base} (${String(suffix)})${ext}`
		let candidateKey = candidate.normalize("NFC").toLowerCase()

		while (emitted.has(candidateKey)) {
			suffix += 1
			candidate = `${base} (${String(suffix)})${ext}`
			candidateKey = candidate.normalize("NFC").toLowerCase()
		}

		nextSuffix.set(key, suffix + 1)
		emitted.add(candidateKey)

		return candidate
	})
}
