import { ListChecksIcon, TextIcon, CodeIcon, NotepadTextIcon, BookMarkedIcon, ArchiveIcon, Trash2Icon, type LucideIcon } from "lucide-react"
import type { Note, NoteType } from "@filen/sdk-rs"

// Type → icon + color, the fixed mapping shared with the new mobile app and old-web (01-DECISIONS D1,
// oldweb-notes §2): checklist purple, text blue, code red, rich cyan, md indigo. Colors are decorative
// per-type marks (raw palette shades, like drive's text-amber-500 undecryptable mark), not semantic
// tokens. `noteType` is the wasm STRING union here, not the uniffi enum object — a plain record keyed
// by the literal strings, exhaustive over NoteType so a future variant fails to compile until mapped.
const NOTE_TYPE_ICON: Record<NoteType, { icon: LucideIcon; colorClass: string }> = {
	checklist: { icon: ListChecksIcon, colorClass: "text-purple-500" },
	text: { icon: TextIcon, colorClass: "text-blue-500" },
	code: { icon: CodeIcon, colorClass: "text-red-500" },
	rich: { icon: NotepadTextIcon, colorClass: "text-cyan-500" },
	md: { icon: BookMarkedIcon, colorClass: "text-indigo-500" }
}

export interface NoteIcon {
	icon: LucideIcon
	colorClass: string
}

// Archive/trash override the type icon (oldweb-notes §1 row content): a trashed note shows the trash
// mark, an archived note the archive mark, otherwise the per-type icon. Trash wins over archive to
// mirror the sort bucket's own trash-over-archive tiering (features/notes/lib/sort.ts).
export function noteIcon(note: Note): NoteIcon {
	if (note.trash) {
		return { icon: Trash2Icon, colorClass: "text-red-500" }
	}

	if (note.archive) {
		return { icon: ArchiveIcon, colorClass: "text-amber-500" }
	}

	return NOTE_TYPE_ICON[note.noteType]
}

// Bare per-type icon (no archive/trash override) — for a type picker or legend that names the type
// itself rather than a specific note's current lifecycle state.
export function noteTypeIcon(noteType: NoteType): NoteIcon {
	return NOTE_TYPE_ICON[noteType]
}
