import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { useNoteContentQuery } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { useNoteInflight } from "@/features/notes/store/useNotesInflight"
import { sync } from "@/features/notes/lib/sync"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import {
	deriveEditorSeed,
	deriveEditorRemountKey,
	deriveEditorReadOnly,
	deriveEditorLoadState,
	deriveSessionBaseHash,
	reducePersistFailureNotice,
	latestInflightContent,
	exceedsNoteSizeCap,
	type EditorLoadState
} from "@/features/notes/hooks/useNoteEditor.logic"

export interface NoteEditorController {
	status: EditorLoadState
	errorDto: ErrorDTO | undefined
	// The frozen mount seed (inflight-first). The editor freezes this at mount; consume it keyed on
	// `remountKey` so a re-render can never re-paste it into a live editor and revert typed text.
	seed: string
	// note.uuid + dataUpdatedAt — the editor's remount key. Cannot advance mid-edit (the content query
	// is disabled while inflight), so a keyed editor never remounts and wipes the cursor mid-session.
	remountKey: string
	readOnly: boolean
	isInflight: boolean
	// True once a change pushed the content past MAX_NOTE_SIZE — the over-cap change was NOT enqueued.
	sizeReached: boolean
	onChange: (value: string) => void
}

// The shared editing controller for every note-type editor (text/code/md here; rich/checklist reuse it
// next). It never calls the SDK: onChange writes to the fault-tolerant outbox (sync.enqueue), the only
// thing that pushes. Derivations are the pure functions in useNoteEditor.logic.ts (unit-tested); this
// hook only wires them to the live query + outbox store. A faithful port of mobile's content/index.tsx
// editor coordination (editorSeed, sessionBaseHashRef, the read-only/size enqueue guards).
export function useNoteEditor(note: Note): NoteEditorController {
	const { t } = useTranslation("notes")
	const query = useNoteContentQuery(note)
	const isInflight = useNoteInflight(note.uuid)
	const [sizeReached, setSizeReached] = useState(false)

	const queryStatus: EditorLoadState = query.isPending ? "pending" : query.isError ? "error" : "ready"
	const status = deriveEditorLoadState({ hasInflight: isInflight, queryStatus })
	const readOnly = deriveEditorReadOnly(note)

	// Reactive read of the freshest inflight content for the seed — a zustand selector (not a plain
	// getState() read during render) so React Compiler treats its return value as always-fresh and a
	// disk-restored edit that hydrates AFTER first render still reaches the seed. Collapsed to the
	// content string, so a keystroke on ANOTHER note never re-renders this one; a keystroke on THIS note
	// does, but the editor freezes `seed` at mount (remountKey) and ignores the churn.
	const inflightLatest = useNotesInflightStore(state => latestInflightContent(state.inflightContent[note.uuid]))
	const seed = deriveEditorSeed({ inflightLatest, queryContent: query.data })
	const remountKey = deriveEditorRemountKey({ uuid: note.uuid, dataUpdatedAt: query.dataUpdatedAt })
	const errorDto = query.isError ? asErrorDTO(query.error) : undefined

	// Session base hash: the hash of the content THIS editing session was seeded from, stamped onto
	// the first outbox entry of a session (buildInflightEntries) for overwrite-conflict detection. The
	// ref renews when a fresh seed arrives with no session ongoing (no inflight for this note) AND on the
	// drain edge — keying the effect on `isInflight` is load-bearing because a full drain writes the
	// just-synced content back into the cache, so the seed string is unchanged across the boundary and a
	// seed-only trigger would leave the base frozen at the mount seed. Mobile's sessionBaseHashRef.
	const sessionBaseHashRef = useRef<string | null>(null)

	useEffect(() => {
		sessionBaseHashRef.current = deriveSessionBaseHash({
			seed,
			hasInflight: isInflight,
			current: sessionBaseHashRef.current
		})
	}, [note.uuid, seed, isInflight])

	// Coalesced per-note warning that a durable persist failed (the edit lives in memory + is still
	// pushed when online, but is not safely on this device's disk). One warning per failure streak;
	// re-arms after a persist succeeds. Instance state in a ref so React Compiler cannot memoize it away.
	const persistFailureNotifiedRef = useRef(false)

	function onChange(value: string): void {
		// Defense-in-depth (mobile #40): never enqueue a read-only edit — its push is rejected
		// server-side and the entry never drains, permanently disabling the content query and wedging
		// the note. The editor is rendered read-only here anyway; this is the belt-and-braces layer.
		if (readOnly) {
			return
		}

		// Block the ENQUEUE past the cap, never the keystroke — CodeMirror keeps the text on screen, but
		// a push of it would be server-rejected. The last under-cap content stays the outbox truth.
		if (exceedsNoteSizeCap(value)) {
			setSizeReached(true)

			return
		}

		if (sizeReached) {
			setSizeReached(false)
		}

		// The outbox persists immediately (survives-window-close) and arms the 3s debounce. Surface a
		// coalesced warning if that disk write failed — mirrors the chat composer's persist-failure toast,
		// debounced across keystrokes so a sustained failure warns once, not per character.
		void sync.enqueue(note, value, sessionBaseHashRef.current).then(persisted => {
			const notice = reducePersistFailureNotice({
				persisted,
				alreadyNotified: persistFailureNotifiedRef.current
			})

			persistFailureNotifiedRef.current = notice.notified

			if (notice.warn) {
				toast.error(t("noteNotSavedToDevice"))
			}
		})
	}

	return { status, errorDto, seed, remountKey, readOnly, isInflight, sizeReached, onChange }
}
