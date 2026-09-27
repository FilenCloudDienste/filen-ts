import { createNotePreviewFromContentText, hashNoteContent, run } from "@filen/shared"
import type { SocketEvent, UserInfo, Note } from "@filen/sdk-rs"
import { registerSocketHandler, decryptedOrSkip } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import useNotesInflightStore, {
	TAB_ID,
	endEditingSession,
	entryIsShowable,
	type InflightEntry
} from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { sync } from "@/features/notes/lib/sync"
import { newestEntry, noteKindForPreview } from "@/features/notes/lib/sync.logic"
import { notesQueryUpdate, notesQueryRemove, notesQueryGet, notesQueryRefetch, notesQueryUpsert } from "@/features/notes/queries/notes"
import { markNoteContentUnsynced, noteContentQueryKey, readNoteContent } from "@/features/notes/queries/noteContent"
import { isOwnNotePush, recordNotePush } from "@/features/notes/lib/pushEchoes"
import {
	takeTabEditorEcho,
	shownTabEditors,
	tabEditorBuffer,
	tabEditorBuildsOn,
	tabEditorSeededWithDraft,
	tabEditorDirty,
	tabEditorSynced,
	tabNoteContent
} from "@/features/notes/lib/tabEditors"
import { followContent, reseedTabEditor, takeRemoteContent } from "@/features/notes/lib/remoteContent"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"
import type { AnswerChoice } from "@/lib/storage/outboxChannel"

// The realtime note event handlers — a faithful port of filen-mobile's socketHandlers.ts SEMANTICS
// onto the wasm surface (flat discriminated `event.inner.type`, string-union noteType, MaybeEncrypted
// `{ Decrypted } | { Encrypted }` unions — not the uniffi tagged-tuple shape). Metadata events patch
// the one notes list cache slice via the existing patch helpers; ContentEdited coordinates with the
// sync outbox + the editor's reload-vs-keep banner.

type NoteSocketEvent = Extract<SocketEvent, { type: "note" }>

// An entry that becomes showable (an orphan: its tab is gone) under an editor already on screen is a version
// of the note from elsewhere, which that editor never showed: a clean editor takes it, one with typing of
// its own is asked. Otherwise the next keystroke there would replace it unseen.
useNotesInflightStore.subscribe((state, prev) => {
	for (const uuid of shownTabEditors()) {
		const next = newestShowable(state.inflightContent[uuid])
		const before = newestShowable(prev.inflightContent[uuid])

		if (
			next === undefined ||
			next === before ||
			next.origin === TAB_ID ||
			next.orphan !== true ||
			next.content === before?.content ||
			next.content === tabEditorBuffer(uuid)
		) {
			continue
		}

		if (tabEditorDirty(uuid)) {
			useNotesRemoteEditStore.getState().setRemoteEdited(uuid, { theirs: next.content })
		} else {
			reseedTabEditor(uuid, useNotesRemoteEditStore.getState().openNote === uuid)
		}
	}
})

function newestShowable(entries: InflightEntry[] | undefined): InflightEntry | undefined {
	return newestEntry((entries ?? []).filter(entryIsShowable))
}

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
	// pushes included, and applying one as an edit made elsewhere would clobber the editor that typed it.
	// Another user's edit is never ours. One of this account's is ours only when its content is something
	// this browser pushed (pushEchoes.ts, shared by every tab): the same account editing on another device
	// is an edit like anyone else's. Content that can't be decrypted can't be recognised, and is taken for
	// ours, as is every edit of this account's while the account id is not known yet (cache not warm).
	const userId = currentUserId()

	if (userId === undefined || BigInt(inner.editorId) === userId) {
		if (content === undefined) {
			refetchRowForEcho(inner)

			return
		}

		const hash = hashNoteContent(content)

		if (isOwnNotePush(inner.note, hash)) {
			followOwnPush(inner.note, content, hash)
			refetchRowForEcho(inner)

			return
		}
	}

	const note = notesQueryGet()?.find(n => n.uuid === inner.note)

	if (note === undefined) {
		log.warn("socket", "note contentEdited: note not in cache", inner.note)

		// A note just created elsewhere: its row arrives with the read `new` started, which may predate
		// this edit, and there is no row to patch meanwhile.
		notesQueryRefetch({ onlyIfFetching: true })

		return
	}

	// Dirty ≡ unsynced local changes: an outbox entry, or text typed in this tab's editor that the cloud
	// does not hold yet. Dirty → ASK (the editor's remote-change dialog), never reseed: the user may be
	// typing between debounce flushes, and a reseed remounts the editor under the caret. Content equal to
	// the local edits is no change at all. Clean → take their version: the editor holds nothing that is
	// not in the cloud, so a reseed loses nothing. A question already asked follows each newer version:
	// asked about the newest, retired once there is nothing left to ask (one left on a note not on screen
	// would otherwise offer an outdated version when the note is opened).
	if (noteIsDirty(inner.note)) {
		// The version every unsynced change builds on: no news (a late echo of this browser's own write
		// that was never recorded, or a save of the same text elsewhere).
		if (content !== undefined && unsyncedChangesBuildOn(inner.note, content)) {
			useNotesRemoteEditStore.getState().retireRemoteEdited(inner.note)

			return
		}

		if (content === undefined || content !== tabNoteContent(inner.note)) {
			useNotesRemoteEditStore.getState().setRemoteEdited(inner.note, { theirs: content })

			return
		}

		if (tabEditorBuffer(inner.note) === content) {
			tabEditorSynced(inner.note, content, undefined)
			followContent(inner.note, content)
		}

		useNotesRemoteEditStore.getState().retireRemoteEdited(inner.note)

		return
	}

	useNotesRemoteEditStore.getState().retireRemoteEdited(inner.note)
	// Patch the row (editedTimestamp, noteType, and a fresh preview when the content decrypted), then
	// reseed from their content, saying so when that editor is on screen.
	patchRowFromContentEdited(inner, content)
	takeRemoteContent(inner.note, content, useNotesRemoteEditStore.getState().openNote === inner.note)
}

// The row is not patched for an echo: it may be older than this tab's own later change. A stale type is
// not cosmetic, the next content push sends it back, so an echo whose type differs from the row (a
// retype on another device of this account) re-reads the list instead of patching it. Otherwise only a
// list read in flight is replaced, as it may predate this edit: a note this account just created and
// retyped elsewhere arrives through the read `new` started.
function refetchRowForEcho(inner: Extract<NoteSocketEvent["inner"], { type: "contentEdited" }>): void {
	const cached = notesQueryGet()?.find(n => n.uuid === inner.note)

	notesQueryRefetch({ onlyIfFetching: cached === undefined || cached.noteType === inner.noteType })
}

// Unsynced local changes of a note, in any tab's queue or in this tab's editor.
function noteIsDirty(uuid: string): boolean {
	return queuedFor(uuid).length > 0 || tabEditorDirty(uuid)
}

function queuedFor(uuid: string): InflightEntry[] {
	return useNotesInflightStore.getState().inflightContent[uuid] ?? []
}

// Every unsynced change of the note (queued, and typed in this tab) was made on `content`.
function unsyncedChangesBuildOn(uuid: string, content: string): boolean {
	if (tabEditorDirty(uuid) && !tabEditorBuildsOn(uuid, content)) {
		return false
	}

	const queued = queuedFor(uuid)

	if (queued.length === 0) {
		return true
	}

	const hash = hashNoteContent(content)

	return queued.every(entry => entry.baseContentHash === hash)
}

// An echo of content this browser pushed, from this tab or another. The tab that typed it now builds on
// it; another tab showing the note is behind it: one with nothing typed takes it, one that typed
// something else is asked, as for an edit from another device. Without this, that tab keeps the older
// text, and its next push silently replaces the other tab's.
function followOwnPush(uuid: string, content: string, hash: string): void {
	const buffer = tabEditorBuffer(uuid)

	// Nothing on screen here: a question left standing is superseded once nothing is left unsynced.
	if (buffer === undefined) {
		if (queuedFor(uuid).length === 0) {
			useNotesRemoteEditStore.getState().retireRemoteEdited(uuid)
		}

		return
	}

	// This tab's own push, or its text: its editor builds on it. So it does on the draft it was seeded with,
	// restored from this browser's outbox and pushed as no live tab's, while its typing on top of it is
	// still queued; any other write of that text (another tab restoring it from history) is news.
	const restoredDraft = tabEditorSeededWithDraft(uuid, content) && newestEntry(queuedFor(uuid))?.content === buffer
	const echo = takeTabEditorEcho(uuid, hash)

	// This tab's own text, written before a later push of this tab's that already landed: nothing to take.
	if (echo === "this tab, superseded") {
		return
	}

	if (echo === "this tab" || buffer === content || restoredDraft) {
		tabEditorSynced(uuid, content, hash)
		// The leader tab's push already wrote it; a follower's is written here.
		followContent(uuid, content)

		return
	}

	if (tabEditorDirty(uuid)) {
		useNotesRemoteEditStore.getState().setRemoteEdited(uuid, { theirs: content })

		return
	}

	takeRemoteContent(uuid, content, false)
}

// The dialog's "Load theirs": discard the unsynced local edit and take the server's version. Their content
// is queued as the note's newest edit rather than only reseeded: a push of the local edits may have landed
// after their save (in flight when it arrived, or sent by the leader tab before it heard of the dialog),
// the leader tab's queue still holds the local edits when this runs in a follower, and the push pass
// sends nothing when the cloud already holds it. The editor reseeds from the cache write (it advances the
// remount key). Content that did not come with the event, or could not be decrypted, is read first; when
// that fails too, the content query refetches instead.
export async function reloadRemoteEdit(note: Note): Promise<void> {
	await loadTheirs(note, "theirs")
}

async function loadTheirs(note: Note, choice: AnswerChoice): Promise<void> {
	const theirs = useNotesRemoteEditStore.getState().remoteEdited[note.uuid]?.theirs ?? (await readTheirs(note))

	sync.dropEntry(note.uuid)
	sync.clearRejections(note.uuid)
	endEditingSession(note.uuid)

	const contentKey = noteContentQueryKey(note.uuid)

	if (theirs !== undefined) {
		const flushed = await sync.enqueueAnswer(note, theirs, hashNoteContent(theirs))

		if (!flushed) {
			log.warn("notes", "remote-edit reload: outbox flush failed", note.uuid)
		}

		void queryClient.cancelQueries({ queryKey: contentKey, exact: true })
		queryClient.setQueryData<string>(contentKey, theirs)
		useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid, choice)

		return
	}

	const flushed = await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

	if (!flushed) {
		log.warn("notes", "remote-edit reload: outbox flush failed", note.uuid)
	}

	useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid, choice)

	void queryClient.invalidateQueries({ queryKey: contentKey })
}

async function readTheirs(note: Note): Promise<string | undefined> {
	const read = await run(async () => readNoteContent(note))

	return read.success && read.data.status === "ok" ? read.data.content : undefined
}

// The dialog's "Keep mine": the local edits become the newest version, queued afresh against their
// content as the base, so the push, which the user chose, raises no overwrite warning. Afresh rather than
// left as they are: unsynced entries carry the base they were typed on, and in a follower tab only a new
// edit reaches the leader's queue. Queued even when nothing is unsynced: this tab's push may have landed
// before their save, its response after their event. Only mine equal to the version asked about (read
// when the event carried none) needs nothing. The hold is released once the edit is queued.
export async function keepMineOverRemoteEdit(note: Note): Promise<void> {
	const edit = useNotesRemoteEditStore.getState().remoteEdited[note.uuid]
	const mine = tabNoteContent(note.uuid)
	const theirs = edit === undefined ? undefined : (edit.theirs ?? (await readTheirs(note)))

	if (mine === undefined || edit === undefined || mine === theirs) {
		// Nothing of mine to send: everywhere takes theirs.
		useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid, "theirs")

		return
	}

	sync.dropEntry(note.uuid)
	await sync.enqueueAnswer(note, mine, theirs === undefined ? null : hashNoteContent(theirs))
	useNotesRemoteEditStore.getState().clearRemoteEdited(note.uuid, "mine")
	sync.executeNow()
}

// The dialog's "Save mine as copy": the local edits go to a new note beside this one, titled as a
// conflicted copy, and this note takes the server's version. A copy that fails partway is deleted again,
// so no half-made copy (their content under this note's title) is left behind.
export async function saveRemoteEditMineAsCopy(note: Note, title: string): Promise<ActionOutcome<Note>> {
	const mine = tabNoteContent(note.uuid)

	if (mine === undefined) {
		const message = "saveRemoteEditMineAsCopy: no local content"

		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	let copy: Note | null = null

	try {
		copy = (await runOp(sdkApi.duplicateNote(note))).duplicated
		copy = await runOp(sdkApi.setNoteTitle(copy, title))

		recordNotePush(copy.uuid, mine)

		copy = await runOp(sdkApi.setNoteContent(copy, mine, createNotePreviewFromContentText(noteKindForPreview(copy.noteType), mine)))
	} catch (e) {
		if (copy !== null) {
			await discardPartialCopy(copy)
		}

		return { status: "error", dto: asErrorDTO(e) }
	}

	queryClient.setQueryData(noteContentQueryKey(copy.uuid), mine)
	notesQueryUpsert(copy)
	await loadTheirs(note, "copy")

	return { status: "success", item: copy }
}

// Best effort: a copy that cannot be deleted is listed, rather than left for the next list read to surface.
async function discardPartialCopy(copy: Note): Promise<void> {
	const discarded = await run(async () => {
		await sdkApi.deleteNote(await sdkApi.trashNote(copy))
	})

	if (!discarded.success) {
		log.warn("notes", "conflicted copy: could not delete the partial copy", copy.uuid, discarded.error)
		notesQueryUpsert(copy)
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
