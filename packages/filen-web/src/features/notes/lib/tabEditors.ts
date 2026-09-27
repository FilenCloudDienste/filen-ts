import { localNoteContent } from "@/features/notes/lib/localContent"

// What the note editor in THIS tab shows and has typed, per note. The outbox is shared by every tab (the
// leader's queue, mirrored in the followers), so its entries can be another tab's typing; this records
// whether this tab's editor holds text the cloud does not, or is behind it. Which pushes are this tab's
// own the outbox tells exactly, by entry (Sync.ownsEntry).
interface TabEditor {
	// The editor's remount key when it was seeded; a new key is a new editor surface.
	key: string | null
	// The editor's text: its seed, then every change it queued.
	buffer: string
	// What the buffer builds on and the cloud holds, as far as this tab knows.
	synced: string | undefined
	// The base of a new editing session: the hash of this tab's text last pushed, or of `synced`.
	baseHash: string | undefined
	// Typed into since it was seeded.
	typed: boolean
	// Hashes of this tab's pushes, not yet heard back: their echoes are this tab's.
	authored: string[]
}

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

	editors.set(uuid, {
		key,
		buffer: seed,
		synced,
		baseHash: undefined,
		typed: false,
		// Echoes of this tab's pushes can still arrive after a reseed.
		authored: editor?.authored ?? []
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

// A push of text this tab queued (hashed `hash`) goes out. It is not synced until it lands: a push the
// outbox gives up on leaves the text unsaved on screen. A new session builds on it meanwhile, as the
// cloud will hold it (a follower's cache is only written by the echo).
export function tabEditorPushed(uuid: string, hash: string): void {
	const editor = editors.get(uuid)

	if (editor !== undefined) {
		editor.authored = [...editor.authored, hash].slice(-MAX_AUTHORED)
		editor.baseHash = hash
	}
}

// Whether an echo of `hash` is of this tab's own text; consumes it.
export function takeTabEditorAuthored(uuid: string, hash: string): boolean {
	const editor = editors.get(uuid)
	const at = editor?.authored.indexOf(hash) ?? -1

	if (editor === undefined || at === -1) {
		return false
	}

	editor.authored = editor.authored.slice(at + 1)

	return true
}

// The cloud holds `content` (hashed `hash`, when known), and this tab's text builds on it.
export function tabEditorSynced(uuid: string, content: string, hash: string | undefined): void {
	const editor = shown(uuid)

	if (editor !== undefined) {
		editor.synced = content
		editor.baseHash = hash
	}
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
