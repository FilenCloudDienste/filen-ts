import type { Note, NoteType } from "@filen/sdk-rs"
import { notePlainText } from "@/features/notes/lib/notePlainText"
import { isNoteUndecryptable, noteTitleMatchesSearch } from "@/features/notes/lib/sort"
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@/workers/noteIndex"

// Pure halves of the notes full-text index (searchIndex.ts), testable without a worker.

// What a search knows about the notes' bodies. `body`: notes whose indexed text matched, best first (`rank` 0 is
// the best). `indexed`: every note the index holds text for, matched or not; a note outside it falls back to its
// preview.
export interface NoteSearchHits {
	body: ReadonlyMap<string, { rank: number; snippet: string }>
	indexed: ReadonlySet<string>
}

// The note's visible text, as indexed. Composed (NFC) like the search key; letter case is left to the index's
// tokenizer, so a snippet reads as the note does.
export function noteIndexText(noteType: NoteType, content: string): string {
	return notePlainText({ noteType }, content).normalize("NFC")
}

// An FTS5 query from a search key (nameSearchKey): every whitespace-separated token must match the start of a word.
// Each token is quoted, so FTS5 syntax in it is literal text, and its own punctuation splits it into a phrase. A
// token with no letter or digit matches no word and is left out; null when none is left.
export function buildNoteMatchQuery(key: string): string | null {
	const tokens = key.split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token))

	if (tokens.length === 0) {
		return null
	}

	return tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(" ")
}

// Whether the index's text for a note (read at `stamp`) predates the note as listed.
export function noteIndexIsStale(note: Note, stamp: bigint | undefined): boolean {
	return stamp === undefined || stamp < note.editedTimestamp
}

// Notes whose body the search reads: a title hit already qualifies a note, and an undecryptable note's body read
// always fails (it keeps its preview).
export function noteSearchCandidates(notes: readonly Note[], key: string): Note[] {
	if (key.length === 0) {
		return []
	}

	return notes.filter(note => !isNoteUndecryptable(note) && !noteTitleMatchesSearch(note, key))
}

export interface SnippetPart {
	text: string
	hit: boolean
}

// A snippet from the index, split at its hit markers.
export function splitSnippet(snippet: string): SnippetPart[] {
	const parts: SnippetPart[] = []

	for (const [index, piece] of snippet.split(SNIPPET_OPEN).entries()) {
		const close = piece.indexOf(SNIPPET_CLOSE)

		if (index === 0 || close === -1) {
			if (piece.length > 0) {
				parts.push({ text: piece.replaceAll(SNIPPET_CLOSE, ""), hit: false })
			}

			continue
		}

		parts.push({ text: piece.slice(0, close), hit: true })

		const rest = piece.slice(close + 1)

		if (rest.length > 0) {
			parts.push({ text: rest, hit: false })
		}
	}

	return parts
}
