import type { ChatMessage } from "@filen/sdk-rs"
import { NEW_MODE, type ChatComposerMode } from "@/features/chats/lib/composer.logic"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"

// Loading a message into the composer for editing replaces the draft, so whatever was typed before (and a
// pending reply quote) is held here per chat until the edit ends, then put back. Every edit entry point
// (message menu, hover bar, ArrowUp) and exit (save, cancel) goes through these two
// helpers. The disk mirror skips edit mode, so the restored draft is re-persisted by the composer's
// mirror effect instead of being deleted with the edit body.
const preEditEntries = new Map<string, { draft: string; mode: ChatComposerMode }>()

export function beginMessageEdit(chatUuid: string, message: ChatMessage): void {
	const store = useChatComposerStore.getState()
	const current = store.entries[chatUuid]

	// Switching from one edit target to another keeps what was stashed before the first edit.
	if (current?.mode.kind !== "edit") {
		preEditEntries.set(chatUuid, { draft: current?.draft ?? "", mode: current?.mode ?? NEW_MODE })
	}

	store.beginEdit(chatUuid, { kind: "edit", message }, message.message ?? "")
}

// `messageUuid` narrows the exit to that edit: a save resolving after the user cancelled or moved on to
// another message must not wipe what the composer holds now. No-op when the composer isn't editing.
export function endMessageEdit(chatUuid: string, messageUuid?: string): void {
	const store = useChatComposerStore.getState()
	const mode = store.entries[chatUuid]?.mode

	if (mode?.kind !== "edit" || (messageUuid !== undefined && mode.message.uuid !== messageUuid)) {
		return
	}

	const previous = preEditEntries.get(chatUuid)

	preEditEntries.delete(chatUuid)
	store.reset(chatUuid)

	if (previous === undefined) {
		return
	}

	if (previous.draft.length > 0) {
		store.setDraft(chatUuid, previous.draft)
	}

	if (previous.mode.kind !== "new") {
		store.setMode(chatUuid, previous.mode)
	}
}
