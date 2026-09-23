import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { currentSocketEpoch, socketLiveSince } from "@/lib/sdk/socketSession"
import { useNoteEditing } from "@/features/notes/store/useNotesInflight"
import type { Note } from "@filen/sdk-rs"

// Per-note content, keyed on uuid so switching between two notes' editors never shows a stale read
// while the new one is still in flight — same rationale as drive's itemInfoQueryKey.
export function noteContentQueryKey(uuid: string) {
	return ["notes", "content", { uuid }] as const
}

// Exported bare (no hook wrapper of its own consumes it directly here) so this project's
// node-environment unit tests can exercise it against a mocked sdkApi, same as fetchNotes.
// getNoteContent needs the full Note (not just its uuid) to resolve the note's own encryption key.
export async function fetchNoteContent(note: Note): Promise<string | undefined> {
	return sdkApi.getNoteContent(note)
}

// getNoteContent resolves `undefined` for exactly one reason: the note's content ciphertext failed to
// decrypt. An EMPTY note round-trips as "" and a note whose key never unwrapped ERRORS instead, so
// coalescing it to "" reads unreadable-but-present content as "empty" — an export then writes an empty
// file the user believes is a backup, and the sync reconcile prunes a real draft against a phantom "".
export type NoteContentResult = { status: "ok"; content: string } | { status: "undecryptable" }

export async function readNoteContent(note: Note): Promise<NoteContentResult> {
	const content = await fetchNoteContent(note)

	return content === undefined ? { status: "undecryptable" } : { status: "ok", content }
}

// TanStack Query REJECTS a queryFn that resolves undefined and retry is off, so an undecryptable note
// already fails its content query — with the library's raw "<queryHash> data is undefined" as the
// user-visible message. Throw an identity-checked sentinel instead (same convention as drive's
// IMPORT_CANCELLED) so the editor can tell "could not decrypt" from a genuine fetch failure. A thrown
// queryFn writes NO data, so the value cached under noteContentQueryKey stays a bare string for every
// other reader and for the disk persister.
export const NOTE_CONTENT_UNDECRYPTABLE = Symbol("note-content-undecryptable")

export function isUndecryptableContentError(error: unknown): boolean {
	return error === NOTE_CONTENT_UNDECRYPTABLE
}

export async function fetchNoteContentOrThrow(note: Note): Promise<string> {
	const result = await readNoteContent(note)

	if (result.status === "undecryptable") {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- identity-checked sentinel, see above
		throw NOTE_CONTENT_UNDECRYPTABLE
	}

	return result.content
}

// Each note's last content read that ran entirely under a live socket (socketSession.ts) with no
// contentEdited arriving meanwhile. contentEdited drops a note's entry, a drop or re-auth retires them
// all, and the persister restores content without one. The cache must still hold what the read returned:
// a cancelled read never lands (the queryFn runs on regardless), and a local write replaces it.
const contentReads = new Map<string, { epoch: number; content: string }>()
let contentEditEvents = 0

// Called for EVERY contentEdited, echoes included: the echo test keys on userId, so it also swallows the
// user's own edits from another device, which only a later read picks up.
export function markNoteContentUnsynced(uuid: string): void {
	contentEditEvents++
	contentReads.delete(uuid)
}

async function fetchTrackedNoteContent(note: Note): Promise<string> {
	const epoch = currentSocketEpoch()
	const editEvents = contentEditEvents
	const content = await fetchNoteContentOrThrow(note)

	if (epoch !== null && socketLiveSince(epoch) && editEvents === contentEditEvents) {
		contentReads.set(note.uuid, { epoch, content })
	} else {
		contentReads.delete(note.uuid)
	}

	return content
}

function noteContentIsCurrent(uuid: string, cached: string | undefined): boolean {
	const read = contentReads.get(uuid)

	return read !== undefined && socketLiveSince(read.epoch) && cached === read.content
}

// staleTime: Infinity stops focus/reconnect refetches from clobbering an open editor mid-session. A
// mount forces a refetch ("always") unless the cached content is current per contentReads: this
// query is PERSISTED per-query (queries/client.ts persister) and the sync loop's post-push cache write
// does NOT re-persist to disk, so the first mount after a load must not trust the rehydrated value, and
// neither may a mount after the socket could have missed a contentEdited. Otherwise `true` still
// refetches content an invalidation marked stale. A note the user is editing has the query DISABLED (so
// no mount refetch fires) and its in-progress edit stays protected. Explicit invalidation still owns
// freshness after a confirmed write. `note` is optional so a caller can mount the hook before its Note
// is resolved (the editor route's first render) without a conditional hook.
//
// USAGE NOTE for the editor: `dataUpdatedAt` on this hook's result is the editor remount key —
// because the query is disabled for as long as the user is editing the note, `dataUpdatedAt` cannot
// advance mid-edit, so a component keyed on it never remounts (and blows away in-progress
// keystrokes) while an editing session is open. Disabling does not stop a fetch ALREADY running, so
// the two seams that open a gate cancel one explicitly: useNoteEditor when a keystroke opens the
// editing session, and the outbox at its hydration edge (sync.ts, for a read issued while the store
// still looked clean).
export function useNoteContentQuery(note: Note | undefined, options?: { enabled?: boolean }): UseQueryResult<string | undefined> {
	// UI gating seam: disable the read for as long as the user is editing the note — a pending outbox
	// entry OR an open editor session. `dataUpdatedAt` (the editor's remount key) therefore cannot
	// advance mid-edit, so the editor never remounts and blows away in-progress keystrokes. The outbox
	// entry alone is NOT that gate: every successful push empties it, so a note still being typed into
	// reads as clean from the debounce flush until the next keystroke, and a fetch landing in that gap
	// remounts the live surface — dropping the caret and, with it, every keystroke that follows.
	// Reactive — subscribes to the store's edge.
	const editing = useNoteEditing(note?.uuid ?? "")

	return useQuery({
		queryKey: noteContentQueryKey(note?.uuid ?? ""),
		// `enabled` below guarantees `note` is defined whenever this actually runs — guard-and-throw
		// instead of a `note as Note` cast (this codebase avoids bare null-strip assertions).
		queryFn: () => {
			if (note === undefined) {
				throw new Error("noteContent queryFn: called while disabled (note is undefined)")
			}

			return fetchTrackedNoteContent(note)
		},
		enabled: (options?.enabled ?? true) && note !== undefined && !editing,
		staleTime: Infinity,
		refetchOnMount: query =>
			query.state.status !== "error" && noteContentIsCurrent(note?.uuid ?? "", query.state.data) ? true : "always"
	})
}
