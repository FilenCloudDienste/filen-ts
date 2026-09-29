import { hashNoteContent } from "@filen/shared"
import { localNoteContent } from "@/features/notes/lib/localContent"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"

// What the note editor in THIS tab shows and has typed, per note. The outbox is shared by every tab (the
// leader's queue, mirrored in the followers), so its entries can be another tab's typing; this records
// whether this tab's editor holds text the cloud does not, or is behind it. Which pushes are this tab's
// own the outbox tells exactly, by the entry's origin (Sync), and by the orphan draft this editor showed.
interface TabEditor {
	// The editor's remount key when it was seeded; a new key is a new editor surface.
	key: string | null
	// The text the surface was seeded with, and whether that was an unsynced draft from the outbox (and its
	// hash, once asked).
	seed: string
	draft: boolean
	draftHash: string | undefined
	// The editor's text: its seed, then every change it queued.
	buffer: string
	// What the buffer builds on and the cloud holds, as far as this tab knows.
	synced: string | undefined
	// The base of a new editing session: the hash of this tab's text last pushed, or of `synced`.
	baseHash: string | undefined
	// Typed into since it was seeded.
	typed: boolean
	// This tab's pushes not yet heard back, oldest first, one per entry (by its stamp) however often it
	// was sent: their echoes are this tab's.
	pushes: { hash: string; stamp: number; landed: boolean }[]
}

// How an echo of this browser's write relates to this tab's pushes.
export type EchoOrigin = "this tab" | "this tab, superseded" | "elsewhere"

const MAX_AUTHORED = 8

const editors = new Map<string, TabEditor>()

// The note's editor, while one is shown.
function shown(uuid: string): TabEditor | undefined {
	const editor = editors.get(uuid)

	return editor?.key === null ? undefined : editor
}

// The editor surface keyed `key` shows `seed`, built on `synced` (the content cache). A no-op for a key
// already seeded, so it can run on every render.
export function seedTabEditor(uuid: string, key: string, seed: string, synced: string | undefined): void {
	const editor = editors.get(uuid)

	if (editor?.key === key) {
		return
	}

	const draft = seed !== synced

	editors.set(uuid, {
		key,
		seed,
		draft,
		draftHash: undefined,
		buffer: seed,
		synced,
		// A session on a draft builds on what the draft was typed on, whatever the cache holds.
		baseHash: draft
			? (useNotesInflightStore.getState().inflightContent[uuid] ?? []).find(entry => entry.content === seed)?.baseContentHash
			: undefined,
		typed: false,
		// Echoes of this tab's pushes can still arrive after a reseed.
		pushes: editor?.pushes ?? []
	})
}

// No editor surface is shown for the note (loading, or the editor left it).
export function unseedTabEditor(uuid: string): void {
	const editor = editors.get(uuid)

	if (editor !== undefined) {
		editor.key = null
		editor.typed = false
	}
}

export function forgetTabEditor(uuid: string): void {
	editors.delete(uuid)
}

export function forgetTabEditors(): void {
	editors.clear()
}

// A change the editor queued.
export function tabEditorChanged(uuid: string, value: string): void {
	const editor = shown(uuid)

	if (editor === undefined) {
		return
	}

	editor.buffer = value
	editor.typed = true
}

// Whether the outbox entry `content` (or hashed `hash`) is the orphan draft this editor showed: this tab
// continues it, and its push is this tab's.
export function tabEditorAdopts(uuid: string, content: string | undefined, hash?: string): boolean {
	const editor = shown(uuid)

	if (editor?.draft !== true) {
		return false
	}

	if (content !== undefined) {
		return editor.seed === content
	}

	editor.draftHash ??= hashNoteContent(editor.seed)

	return editor.draftHash === hash
}

// A push of this tab's entry `stamp` (hashed `hash`) goes out: its echo is this tab's. Once per entry, so a
// retry leaves no second record. It is not synced until it lands: a push the outbox gives up on leaves the
// text unsaved on screen.
export function tabEditorPushed(uuid: string, hash: string, stamp: number): void {
	const editor = editors.get(uuid)

	if (editor !== undefined && !editor.pushes.some(push => push.stamp === stamp)) {
		editor.pushes = [...editor.pushes, { hash, stamp, landed: false }].slice(-MAX_AUTHORED)
	}
}

export function tabEditorHasPush(uuid: string, stamp: number): boolean {
	return editors.get(uuid)?.pushes.some(push => push.stamp === stamp) === true
}

// The push of this tab's entry `stamp` (hashed `hash`, `content` when this tab still holds it) landed: this
// tab's text builds on it, and so does a new session.
export function tabEditorLanded(uuid: string, hash: string, stamp: number, content: string | undefined): void {
	const editor = editors.get(uuid)

	if (editor === undefined) {
		return
	}

	editor.pushes = editor.pushes.map(push => (push.stamp === stamp ? { ...push, landed: true } : push))

	if (editor.key === null) {
		return
	}

	editor.baseHash = hash

	if (content !== undefined) {
		editor.synced = content
	}
}

// Takes an echo of this browser's write hashed `hash`: this tab's own push (consumed, with every older one:
// echoes come in order), superseded when a later push of this tab's already landed (the echo is of text
// before it: nothing to take), or a write made elsewhere. Only this tab's own text is ever superseded.
export function takeTabEditorEcho(uuid: string, hash: string): EchoOrigin {
	const editor = editors.get(uuid)
	const at = editor?.pushes.findIndex(push => push.hash === hash) ?? -1

	if (editor === undefined || at === -1) {
		return "elsewhere"
	}

	editor.pushes = editor.pushes.slice(at + 1)

	return editor.pushes.some(push => push.landed) ? "this tab, superseded" : "this tab"
}

// The cloud holds `content` (hashed `hash`, when known), and this tab's text builds on it.
export function tabEditorSynced(uuid: string, content: string, hash: string | undefined): void {
	const editor = shown(uuid)

	if (editor !== undefined) {
		editor.synced = content
		editor.baseHash = hash
	}
}

// The cloud holding `content` is no news to this tab's editor: its text builds on it.
export function tabEditorBuildsOn(uuid: string, content: string): boolean {
	return shown(uuid)?.synced === content
}

// The editor was seeded with the unsynced draft `content` from the outbox (one restored from this
// browser's earlier page load).
export function tabEditorSeededWithDraft(uuid: string, content: string): boolean {
	const editor = shown(uuid)

	return editor !== undefined && editor.draft && editor.seed === content
}

// The notes whose editor this tab shows.
export function shownTabEditors(): string[] {
	return [...editors].flatMap(([uuid, editor]) => (editor.key === null ? [] : [uuid]))
}

export function tabEditorBuffer(uuid: string): string | undefined {
	return shown(uuid)?.buffer
}

// This tab typed text the cloud does not hold yet.
export function tabEditorDirty(uuid: string): boolean {
	const editor = shown(uuid)

	return editor !== undefined && editor.typed && editor.buffer !== editor.synced
}

// The base of a new editing session, when this tab's own push says more than the content cache.
export function tabEditorBaseHash(uuid: string): string | undefined {
	return shown(uuid)?.baseHash
}

// "Mine" in the remote-edit dialog: what this tab typed, else the note as this browser knows it.
export function tabNoteContent(uuid: string): string | undefined {
	const editor = shown(uuid)

	return editor?.typed === true ? editor.buffer : localNoteContent(uuid)
}
