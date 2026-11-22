import {
	datedElsewhereNote,
	listRest,
	matchScore,
	NOTE_TEXT_NEEDS_WORDS,
	NOTE_TEXT_SCAN_MAX_CHARS,
	noteTextCoverageNote,
	NOTES_ITEMS,
	SEARCH_RESULT_ITEMS,
	searchTokens
} from "@filen/shared/assistant"
import type { Note } from "@filen/sdk-rs"
import { notesQueryRead } from "@/features/notes/queries/notes"
import { heldNoteContentMaybeStale, noteContentQueryRead } from "@/features/notes/queries/noteContent"
import { isNoteUndecryptable, sortNotes, tagDisplayName } from "@/features/notes/lib/sort"
import { filterNotesByBlockedOwner } from "@/features/notes/components/notesSidebar.logic"
import { selectedNoteUuidFromPath } from "@/features/notes/lib/route"
import { noteIsEditing, useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import { checklistToMarkdown } from "@/features/notes/lib/export.logic"
import { tabNoteContent } from "@/features/notes/lib/tabEditors"
import { assistantRouter, navigateChecked } from "@/features/assistant/tools/navigation"
import {
	blockedUsers,
	entityVisible,
	freshNote,
	noteTitle,
	optionalString,
	requiredString,
	resolveHandle,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import { AssistantToolError, clipText, isoDate, throwIfStopped } from "@/features/assistant/tools/format"
import { dateSelection, datesField, emptyDatesNote, selects } from "@/features/assistant/tools/dates"

export const NOTE_MAX_CHARS = 4_000

// Notes a text search looks at between yields to the event loop, so a long one never holds the main thread.
const NOTE_TEXT_YIELD_EVERY = 200

async function resolveNote(scope: ToolScope, handle: string): Promise<Note> {
	const entity = await resolveHandle(scope, handle, ["note"])

	if (entity.kind !== "note") {
		throw new AssistantToolError("Not a note", { invalid: true })
	}

	const note = freshNote(entity.note)

	if (!entityVisible({ kind: "note", note })) {
		throw new AssistantToolError("This note is not available")
	}

	if (note.trash) {
		throw new AssistantToolError(`"${noteTitle(note)}" is in the trash`)
	}

	return note
}

// Block breaks become line breaks, then the markup goes: what the reader would show, as plain text.
function richTextToPlain(html: string): string {
	const marked = html.replace(/<\/(p|li|h[1-6]|div|blockquote|pre)>|<br\s*\/?>/gi, "$&\n")

	return new DOMParser()
		.parseFromString(marked, "text/html")
		.body.textContent.replace(/\n{3,}/g, "\n\n")
		.trim()
}

function plainContent(note: Note, content: string): string {
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

// A date filter and `only` (pinned, favorite, archived, or the trashed notes no other filter lists) apply before the cut, so notes past the first rows
// (archived notes sort last, favorites are not lifted) are still found. Small models add a period nobody asked for, so one that alone empties a search by words gives
// way: the notes matching the words come back, with a note that none is dated in the period.
export const listNotesTool: ToolAdapter = async (input, scope) => {
	const tokens = searchTokens(optionalString(input, "query") ?? "")
	const selection = dateSelection(input, ["edited"], scope.calendar)
	const only = optionalString(input, "only") ?? "any"
	const matching = sortNotes(filterNotesByBlockedOwner(await notesQueryRead(), blockedUsers()))
		.filter(
			note =>
				note.trash === (only === "trashed") &&
				(only === "pinned" ? note.pinned : only === "favorite" ? note.favorite : only === "archived" ? note.archive : true)
		)
		.map(note => ({
			note,
			score: tokens.length === 0 ? 0 : matchScore(`${noteTitle(note)} ${note.tags.map(tagDisplayName).join(" ")}`, tokens)
		}))
		.filter(({ score }) => tokens.length === 0 || score > 0)
	const dated = matching.filter(({ note }) => selects(selection, Number(note.editedTimestamp)))
	const undated = dated.length === 0 && tokens.length > 0 && matching.length > 0 && selection.range !== null
	// Notes matching every word first, in the sidebar's order; then the rest by how many words they match.
	const notes = (undated ? matching : dated).toSorted((a, b) => b.score - a.score).map(({ note }) => note)

	return {
		value: {
			notes: notes.slice(0, NOTES_ITEMS).map(note => {
				const title = noteTitle(note)
				const tags = note.tags.map(tagDisplayName)

				return {
					handle: scope.show({ kind: "note", note }, title),
					title,
					type: note.noteType,
					edited: isoDate(note.editedTimestamp),
					...(tags.length > 0 ? { tags } : {}),
					...(note.pinned ? { pinned: true } : {}),
					...(note.favorite ? { favorite: true } : {}),
					...(note.archive ? { archived: true } : {}),
					...(note.trash ? { trashed: true } : {})
				}
			}),
			...listRest(notes.length, NOTES_ITEMS),
			...(undated ? {} : datesField(selection)),
			...(undated && selection.range !== null
				? { note: datedElsewhereNote(selection.range) }
				: emptyDatesNote(selection, notes.length, matching.length))
		}
	}
}

// A note open in the editor or holding unsynced edits is read from what this tab knows, the editor's
// typed text first (tabNoteContent), never fetched: a read landing would advance the editor's remount
// key under the caret, and the server copy is older than what the user typed. Reading writes nothing.
export const readNoteTool: ToolAdapter = async (input, scope) => {
	const note = await resolveNote(scope, requiredString(input, "handle"))
	const title = noteTitle(note)
	const pathname = assistantRouter()?.state.location.pathname ?? ""

	if (isNoteUndecryptable(note)) {
		throw new AssistantToolError("This note cannot be decrypted")
	}

	const live = selectedNoteUuidFromPath(pathname) === note.uuid || noteIsEditing(useNotesInflightStore.getState(), note.uuid)
	const content = live ? tabNoteContent(note.uuid) : await noteContentQueryRead(note)

	if (content === undefined) {
		throw new AssistantToolError(`"${title}" is still loading in the editor; try again in a moment`)
	}

	const { text, truncated } = clipText(plainContent(note, content), NOTE_MAX_CHARS)

	return {
		value: {
			handle: scope.show({ kind: "note", note }, title),
			title,
			content: text,
			...(truncated ? { truncated: true } : {})
		}
	}
}

export const openNoteTool: ToolAdapter = async (input, scope) => {
	const note = await resolveNote(scope, requiredString(input, "handle"))
	const router = assistantRouter()

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	await navigateChecked({
		router,
		navigate: () => router.navigate({ to: "/notes/$uuid", params: { uuid: note.uuid } }),
		landed: pathname => pathname === `/notes/${note.uuid}`,
		signal: scope.signal
	})

	return { value: { opened: noteTitle(note) } }
}

function yieldToMain(): Promise<void> {
	return "scheduler" in globalThis ? scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0))
}

// Only the text this tab already holds, never fetched: the editor's typed text, an unsynced edit, else the
// content cache, which the persister fills at boot with every body read before on this device (about every
// note once the sidebar searched their text). Sidebar order, so the notes the user sees first are searched
// first when the cap cuts the scan. A body restored and not read since may be older than the cloud's
// (maybeStale). Returns handles, titles and how many query words matched, never the text.
export const searchNoteTextTool: ToolAdapter = async (input, scope) => {
	const tokens = searchTokens(requiredString(input, "query"))

	if (tokens.length === 0) {
		throw new AssistantToolError(NOTE_TEXT_NEEDS_WORDS, { invalid: true })
	}

	const notes = sortNotes(filterNotesByBlockedOwner(await notesQueryRead(), blockedUsers())).filter(
		note => !note.trash && !isNoteUndecryptable(note)
	)
	const hits: { note: Note; tokensMatched: number; maybeStale: boolean }[] = []
	let searched = 0
	let scanned = 0
	let cut = false

	for (const [index, note] of notes.entries()) {
		if (index > 0 && index % NOTE_TEXT_YIELD_EVERY === 0) {
			await yieldToMain()
			throwIfStopped(scope)
		}

		const content = tabNoteContent(note.uuid)

		if (content === undefined) {
			continue
		}

		if (scanned > 0 && scanned + content.length > NOTE_TEXT_SCAN_MAX_CHARS) {
			cut = true

			break
		}

		scanned += content.length
		searched++

		const tokensMatched = matchScore(`${noteTitle(note)}\n${plainContent(note, content)}`, tokens)

		if (tokensMatched > 0) {
			hits.push({ note, tokensMatched, maybeStale: heldNoteContentMaybeStale(note.uuid, content) })
		}
	}

	// Notes matching the most words first, each count in the sidebar's order.
	const ranked = hits.toSorted((a, b) => b.tokensMatched - a.tokensMatched)

	return {
		value: {
			notes: ranked.slice(0, SEARCH_RESULT_ITEMS).map(({ note, tokensMatched, maybeStale }) => {
				const title = noteTitle(note)

				return {
					handle: scope.show({ kind: "note", note }, title),
					title,
					tokensMatched,
					...(maybeStale ? { maybeStale: true } : {})
				}
			}),
			queryTokens: tokens.length,
			...listRest(ranked.length, SEARCH_RESULT_ITEMS),
			note: noteTextCoverageNote({ searched, total: notes.length, cut })
		}
	}
}
