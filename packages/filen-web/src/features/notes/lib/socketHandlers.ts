import { createNotePreviewFromContentText } from "@filen/shared"
import type { SocketEvent, UserInfo, Note } from "@filen/sdk-rs"
import { registerSocketHandler, decryptedOrSkip } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import useNotesInflightStore, { isNoteEditing, endEditingSession } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { sync } from "@/features/notes/lib/sync"
import { noteKindForPreview } from "@/features/notes/lib/sync.logic"
import { notesQueryUpdate, notesQueryRemove, notesQueryGet, notesQueryRefetch } from "@/features/notes/queries/notes"
import { markNoteContentUnsynced, noteContentQueryKey } from "@/features/notes/queries/noteContent"

// The realtime note event handlers — a faithful port of filen-mobile's socketHandlers.ts SEMANTICS
// onto the wasm surface (flat discriminated `event.inner.type`, string-union noteType, MaybeEncrypted
// `{ Decrypted } | { Encrypted }` unions — not the uniffi tagged-tuple shape). Metadata events patch
// the one notes list cache slice via the existing patch helpers; ContentEdited coordinates with the
// sync outbox + the editor's reload-vs-keep banner.

type NoteSocketEvent = Extract<SocketEvent, { type: "note" }>

// Registers the note handler on the generic bridge; returns the unregister fn. Called once by the
// authed shell's socket host. Only "note" events reach handleNoteEvent — the registry routes by type.
export function registerNoteSocketHandlers(): () => void {
	return registerSocketHandler("note", handleNoteEvent)
}

// The current account's numeric user id, read off the account query cache (no subscription — this runs
// outside React). bigint on the wasm surface; ContentEdited.editorId is a number, so echo suppression
// compares BigInt(editorId) === id.
function currentUserId(): bigint | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.id
}

export function handleNoteEvent(event: NoteSocketEvent): void {
	const inner = event.inner

	switch (inner.type) {
		case "archived": {
			notesQueryUpdate(prev => prev.map(n => (n.uuid === inner.note ? { ...n, archive: true } : n)))

			break
		}

		case "restored": {
			notesQueryUpdate(prev => prev.map(n => (n.uuid === inner.note ? { ...n, archive: false, trash: false } : n)))

			break
		}

		case "deleted": {
			notesQueryRemove(inner.note)

			break
		}

		case "titleEdited": {
			const title = decryptedOrSkip(inner.newTitle, "note titleEdited")

			if (title === undefined) {
				break
			}

			notesQueryUpdate(prev => prev.map(n => (n.uuid === inner.note ? { ...n, title } : n)))

			break
		}

		case "participantNew": {
			notesQueryUpdate(prev =>
				prev.map(n =>
					n.uuid === inner.note
						? { ...n, participants: [...n.participants.filter(p => p.userId !== inner.participant.userId), inner.participant] }
						: n
				)
			)

			break
		}

		case "participantRemoved": {
			notesQueryUpdate(prev =>
				prev.map(n => (n.uuid === inner.note ? { ...n, participants: n.participants.filter(p => p.userId !== inner.userId) } : n))
			)

			break
		}

		case "participantPermissions": {
			notesQueryUpdate(prev =>
				prev.map(n =>
					n.uuid === inner.note
						? {
								...n,
								participants: n.participants.map(p =>
									p.userId === inner.userId ? { ...p, permissionsWrite: inner.permissionsWrite } : p
								)
							}
						: n
				)
			)

			break
		}

		case "new": {
			// The payload is sparse (`{ note: uuid }`, no Note), so a list read is the only source of the
			// row. It runs through the query, never out of band: a write landing while it is in flight
			// (createNote's own upsert, the type and title edits that follow a create elsewhere) replaces it
			// with a read that starts after (notesQueryUpdate, handleContentEdited), so no snapshot older
			// than those writes reaches the cache.
			notesQueryRefetch()

			break
		}

		case "contentEdited": {
			handleContentEdited(inner)

			break
		}

		default: {
			// Exhaustive over NoteEvent's 9 variants — a new variant fails to compile here until mapped.
			log.error("socket", "unhandled note event", (inner as { type: string }).type)

			break
		}
	}
}

function handleContentEdited(inner: Extract<NoteSocketEvent["inner"], { type: "contentEdited" }>): void {
	// Before every early return below: whichever branch runs, the cached content may now be behind.
	markNoteContentUnsynced(inner.note)

	// Echo suppression — mobile keys on editorId === own userId (screens content/index.tsx): the server
	// echoes a note author's OWN edit back to them, and applying it would clobber the editor. All our
	// tabs share one userId, so cross-TAB echoes are suppressed too — correct as long as tabs stay
	// uncoordinated by a per-tab leader (there is none today). A missing account id (cache not warm) can't
	// suppress; it falls through to the dirty/clean branch below, which is safe (a clean note refetches
	// server-authoritative content anyway).
	const userId = currentUserId()

	if (userId !== undefined && BigInt(inner.editorId) === userId) {
		// The row is not patched either: an echo may be older than this tab's own later change. A stale
		// type is not cosmetic, the next content push sends it back, so an echo whose type differs from
		// the row (a retype on another device of this account) re-reads the list instead of patching it.
		// Otherwise only a list read in flight is replaced, as it may predate this edit: a note this
		// account just created and retyped elsewhere arrives through the read `new` started.
		const cached = notesQueryGet()?.find(n => n.uuid === inner.note)

		notesQueryRefetch({ onlyIfFetching: cached === undefined || cached.noteType === inner.noteType })

		return
	}

	const note = notesQueryGet()?.find(n => n.uuid === inner.note)

	if (note === undefined) {
		log.warn("socket", "note contentEdited: note not in cache", inner.note)

		// A note just created elsewhere: its row arrives with the read `new` started, which may predate
		// this edit, and there is no row to patch meanwhile.
		notesQueryRefetch({ onlyIfFetching: true })

		return
	}

	// Dirty ≡ the user is editing this note: an outbox entry OR an open editor session. The entry alone
	// is the wrong test — a push empties it, so a note being typed into reads as clean for the gap
	// between the debounce flush and the next keystroke, and invalidating there refetches, advances the
	// content query's dataUpdatedAt and remounts the live editor, dropping the caret mid-word. Dirty →
	// PROMPT (banner); never invalidate while editing (the query is disabled, so it would only defer).
	if (isNoteEditing(inner.note)) {
		useNotesRemoteEditStore.getState().setRemoteEdited(inner.note)

		return
	}

	// Clean → patch the row (editedTimestamp, noteType, and a fresh preview when the content decrypted)
	// then invalidate the content query so a mounted editor reseeds with the server's version. The query
	// is enabled (not inflight) so invalidation refetches immediately.
	patchRowFromContentEdited(inner)

	void queryClient.invalidateQueries({ queryKey: noteContentQueryKey(inner.note) })
}

// The banner's "Reload" action: discard the unsynced local edit and take the server's version. dropEntry
// plus closing the editing session re-enable the note's content query (enabled: !editing) so its remount
// key can advance and the editor reseeds with fresh content — a reseed is the whole point here, so this
// is the one place that ends a session an editor is still mounted on; clearRejections + flushToDisk make
// the discard durable with a clean strike count; invalidate marks the content stale so the re-enabled
// query refetches. Extracted (not inlined in the banner) so this project's node-environment tests
// exercise it against a mocked sync + queryClient.
export async function reloadRemoteEdit(note: Note): Promise<void> {
	sync.dropEntry(note.uuid)
	sync.clearRejections(note.uuid)
	endEditingSession(note.uuid)

	const flushed = await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

	if (!flushed) {
		log.warn("notes", "remote-edit reload: outbox flush failed", note.uuid)
	}

	useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid)

	void queryClient.invalidateQueries({ queryKey: noteContentQueryKey(note.uuid) })
}

// The banner's "Keep mine" action: dismiss the prompt, leave the outbox untouched (local wins on the
// next push — a conflict toast may still fire, correct mobile behavior).
export function dismissRemoteEdit(uuid: string): void {
	useNotesRemoteEditStore.getState().clearRemoteEdited(uuid)
}

function patchRowFromContentEdited(inner: Extract<NoteSocketEvent["inner"], { type: "contentEdited" }>): void {
	const content = decryptedOrSkip(inner.content, "note contentEdited")
	const preview = content !== undefined ? createNotePreviewFromContentText(noteKindForPreview(inner.noteType), content) : undefined

	notesQueryUpdate(prev =>
		prev.map(n =>
			n.uuid === inner.note
				? {
						...n,
						noteType: inner.noteType,
						editedTimestamp: inner.editedTimestamp,
						...(preview !== undefined ? { preview } : {})
					}
				: n
		)
	)
}
