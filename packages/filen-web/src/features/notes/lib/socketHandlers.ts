import { toast } from "sonner"
import { createNotePreviewFromContentText, hashNoteContent } from "@filen/shared"
import type { SocketEvent, UserInfo, Note } from "@filen/sdk-rs"
import { registerSocketHandler, decryptedOrSkip } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import useNotesInflightStore, { isNoteEditing, endEditingSession } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { sync } from "@/features/notes/lib/sync"
import { noteKindForPreview } from "@/features/notes/lib/sync.logic"
import { notesQueryUpdate, notesQueryRemove, notesQueryGet, notesQueryRefetch, notesQueryUpsert } from "@/features/notes/queries/notes"
import { markNoteContentUnsynced, noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { localNoteContent } from "@/features/notes/lib/localContent"
import { isOwnNotePush } from "@/features/notes/lib/pushEchoes"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"

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

	const content = decryptedOrSkip(inner.content, "note contentEdited")

	// Echo suppression. The server sends an edit back to every session of its author, this browser's own
	// pushes included, and applying one would clobber the editor. Another user's edit is never ours. One
	// of this account's is ours only when its content is something this browser pushed (pushEchoes.ts,
	// shared by every tab): the same account editing on another device is an edit like anyone else's.
	// Content that can't be decrypted can't be recognised, and is taken for ours, as is every edit of
	// this account's while the account id is not known yet (cache not warm).
	const userId = currentUserId()
	const ownAccount = userId === undefined || BigInt(inner.editorId) === userId

	if (ownAccount && (content === undefined || isOwnNotePush(inner.note, hashNoteContent(content)))) {
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
	// ASK (the editor's remote-change dialog); never invalidate while editing (the query is disabled, so
	// it would only defer). Content equal to the local edits is no change at all.
	if (isNoteEditing(inner.note)) {
		if (content === undefined || content !== localNoteContent(inner.note)) {
			useNotesRemoteEditStore.getState().setRemoteEdited(inner.note, { theirs: content })
		}

		return
	}

	// Clean → patch the row (editedTimestamp, noteType, and a fresh preview when the content decrypted)
	// then invalidate the content query so a mounted editor reseeds with the server's version, saying so
	// when that editor is on screen. The query is enabled (not inflight) so invalidation refetches
	// immediately.
	patchRowFromContentEdited(inner, content)

	void queryClient.invalidateQueries({ queryKey: noteContentQueryKey(inner.note) })

	if (useNotesRemoteEditStore.getState().openNote === inner.note) {
		toast(i18n.t("notes:noteUpdatedElsewhere"))
	}
}

// The dialog's "Load theirs": discard the unsynced local edit and take the server's version. dropEntry
// plus closing the editing session re-enable the note's content query (enabled: !editing) so its remount
// key can advance and the editor reseeds with fresh content — a reseed is the whole point here, so this
// is the one place that ends a session an editor is still mounted on; clearRejections + flushToDisk make
// the discard durable with a clean strike count; invalidate marks the content stale so the re-enabled
// query refetches. Extracted (not inlined in the dialog) so this project's node-environment tests
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

// The dialog's "Keep mine": the local edits become the newest version. An unsynced edit is pushed anyway;
// edits already pushed (the other device's save went over them) are queued again. Queued against their
// content as the base, so the push, which the user chose, raises no overwrite warning.
export async function keepMineOverRemoteEdit(note: Note): Promise<void> {
	const edit = useNotesRemoteEditStore.getState().remoteEdited[note.uuid]

	useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid)

	const mine = localNoteContent(note.uuid)
	const hasUnsynced = (useNotesInflightStore.getState().inflightContent[note.uuid] ?? []).length > 0

	if (mine === undefined || edit === undefined) {
		return
	}

	if (!hasUnsynced) {
		await sync.enqueue(note, mine, edit.theirs === undefined ? null : hashNoteContent(edit.theirs))
	}

	sync.executeNow()
}

// The dialog's "Save mine as copy": the local edits go to a new note beside this one, titled as a
// conflicted copy, and this note takes the server's version.
export async function saveRemoteEditMineAsCopy(note: Note, title: string): Promise<ActionOutcome<Note>> {
	const mine = localNoteContent(note.uuid)

	if (mine === undefined) {
		const message = "saveRemoteEditMineAsCopy: no local content"

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	try {
		const { duplicated } = await runOp(sdkApi.duplicateNote(note))
		const retitled = await runOp(sdkApi.setNoteTitle(duplicated, title))

		await runOp(sdkApi.setNoteContent(retitled, mine, createNotePreviewFromContentText(noteKindForPreview(retitled.noteType), mine)))

		queryClient.setQueryData(noteContentQueryKey(retitled.uuid), mine)
		notesQueryUpsert(retitled)
		await reloadRemoteEdit(note)

		return { status: "success", item: retitled }
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}
}

function patchRowFromContentEdited(inner: Extract<NoteSocketEvent["inner"], { type: "contentEdited" }>, content: string | undefined): void {
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
