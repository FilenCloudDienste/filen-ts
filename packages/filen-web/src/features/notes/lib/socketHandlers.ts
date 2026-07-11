import { createNotePreviewFromContentText } from "@filen/utils"
import type { SocketEvent, UserInfo, Note } from "@filen/sdk-rs"
import { registerSocketHandler, decryptedOrSkip } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import useNotesInflightStore, { hasInflight } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { sync } from "@/features/notes/lib/sync"
import { noteKindForPreview } from "@/features/notes/lib/sync.logic"
import { fetchNotes, notesQueryUpdate, notesQueryRemove, notesQueryReplaceAll, notesQueryGet } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"

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
			// Mobile refetches the list rather than build the row from the sparse `{ note: uuid }` payload
			// (it carries no Note). Fetch + replace so the new (or newly-shared-in) note lands with full
			// metadata. Fire-and-forget: a failed refetch just leaves the list until the next trigger.
			void refetchNotesList()

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

async function refetchNotesList(): Promise<void> {
	try {
		notesQueryReplaceAll(await fetchNotes())
	} catch (e) {
		log.error("socket", "note new: list refetch failed", e)
	}
}

function handleContentEdited(inner: Extract<NoteSocketEvent["inner"], { type: "contentEdited" }>): void {
	// Echo suppression — mobile keys on editorId === own userId (screens content/index.tsx): the server
	// echoes a note author's OWN edit back to them, and applying it would clobber the editor. All our
	// tabs share one userId, so cross-TAB echoes are suppressed too — correct until the multi-tab leader
	// wave. A missing account id (cache not warm) can't suppress; it falls through to the dirty/clean
	// branch below, which is safe (a clean note refetches server-authoritative content anyway).
	const userId = currentUserId()

	if (userId !== undefined && BigInt(inner.editorId) === userId) {
		return
	}

	const note = notesQueryGet()?.find(n => n.uuid === inner.note)

	if (note === undefined) {
		log.warn("socket", "note contentEdited: note not in cache", inner.note)

		return
	}

	// Dirty ≡ has an outbox entry: on web every keystroke enqueues synchronously (useNoteEditor.onChange),
	// so there is no dirty-but-not-inflight buffer state to track separately. Dirty → PROMPT (banner);
	// never invalidate while inflight (the content query is disabled, so an invalidate would only defer).
	if (hasInflight(inner.note)) {
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
// re-enables the note's content query (enabled: !inflight) so its remount key can advance and the editor
// reseeds with fresh content; clearRejections + flushToDisk make the discard durable with a clean strike
// count; invalidate marks the content stale so the re-enabled query refetches. Extracted (not inlined in
// the banner) so this project's node-environment tests exercise it against a mocked sync + queryClient.
export async function reloadRemoteEdit(note: Note): Promise<void> {
	sync.dropEntry(note.uuid)
	sync.clearRejections(note.uuid)

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
