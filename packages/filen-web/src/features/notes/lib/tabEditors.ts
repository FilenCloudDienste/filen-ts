import { hashNoteContent } from "@filen/shared"
import { localNoteContent } from "@/features/notes/lib/localContent"

// What the note editor in THIS tab shows and has typed, per note. The outbox is shared by every tab (the
// leader's queue, mirrored in the followers), so its entries can be another tab's typing; this is the
// only record of which edits are this tab's own, and of whether its editor is behind the cloud.
interface TabEditor {
	// The editor's remount key when it was seeded; a new key is a new editor surface.
	key: string | null
	// The editor's text: its seed, then every change it queued.
	buffer: string
	// What the buffer builds on and the cloud holds, as far as this tab knows.
	synced: string | undefined
	// Hash of `synced`, when a push of this tab's text set it.
	syncedHash: string | undefined
	// Typed into since it was seeded.
	typed: boolean
	// The buffers before the current one, oldest first: a push picks its content before a peek round
	// trip, and the user may type on meanwhile.
	recent: string[]
	// Hashes of this tab's text that this browser pushed, not yet heard back: their echoes are this tab's.
	authored: string[]
}

const MAX_RECENT = 4
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
		syncedHash: undefined,
		typed: false,
		recent: [],
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
		editor.recent = []
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

	if (editor.typed) {
		editor.recent.push(editor.buffer)

		if (editor.recent.length > MAX_RECENT) {
			editor.recent.shift()
		}
	}

	editor.buffer = value
	editor.typed = true
}

// The leader pushes `hash` for the note (`content` in the leader tab itself, compared without hashing).
// When it is text this tab typed, that text is what the tab builds on from now: the push is still in
// flight, but its entry stays queued until it lands, and the queue counts as unsynced meanwhile.
export function tabEditorPushed(uuid: string, hash: string, content?: string): void {
	const editor = shown(uuid)

	if (editor?.typed !== true) {
		return
	}

	const candidates = [...editor.recent, editor.buffer]

	for (let at = candidates.length - 1; at >= 0; at--) {
		const candidate = candidates[at]

		if (candidate === undefined || (content !== undefined ? candidate !== content : hashNoteContent(candidate) !== hash)) {
			continue
		}

		editor.synced = candidate
		editor.syncedHash = hash
		editor.recent = editor.recent.slice(at + 1)
		editor.authored = [...editor.authored, hash].slice(-MAX_AUTHORED)

		return
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

// The cloud holds `content` (hashed `hash`), and this tab's text builds on it.
export function tabEditorSynced(uuid: string, content: string, hash: string): void {
	const editor = shown(uuid)

	if (editor !== undefined) {
		editor.synced = content
		editor.syncedHash = hash
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

// The base of a new editing session, when this tab's own push says more than the content cache: in a
// follower tab the cache is only written by the push's echo.
export function tabEditorBaseHash(uuid: string): string | undefined {
	return shown(uuid)?.syncedHash
}

// "Mine" in the remote-edit dialog: what this tab typed, else the note as this browser knows it.
export function tabNoteContent(uuid: string): string | undefined {
	const editor = shown(uuid)

	return editor?.typed === true ? editor.buffer : localNoteContent(uuid)
}
