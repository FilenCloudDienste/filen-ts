// The currently-open conversation, tracked OUTSIDE React so the socket handlers (which run outside any
// render) can gate derived-unread the way mobile gates on its navigation state: a foreign messageNew for
// the chat the user is actively looking at must NOT flip that row to unread. The MessageThread sets this
// on mount and clears it on unmount / chat change. A backgrounded tab is never "focused" even while the
// route is mounted — an unread that lands while the window is hidden should still show.

let focusedChatUuid: string | null = null

export function setFocusedChat(uuid: string | null): void {
	focusedChatUuid = uuid
}

export function getFocusedChat(): string | null {
	return focusedChatUuid
}

// Focused ≡ this chat's thread is the open route AND the document is visible (foreground). `document`
// is guarded so the pure logic stays callable under the node test environment.
export function isChatFocused(uuid: string): boolean {
	if (focusedChatUuid !== uuid) {
		return false
	}

	return typeof document === "undefined" || document.visibilityState === "visible"
}
