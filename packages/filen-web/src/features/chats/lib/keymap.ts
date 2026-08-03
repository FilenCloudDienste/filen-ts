import type { ActionDef } from "@/lib/keymap/registry"

// Multi-select commands, mirroring drive's and notes' exactly: mod+a selects every currently
// visible (search-filtered) decryptable conversation, Escape clears the selection.
export const CHATS_ACTIONS: readonly ActionDef[] = [
	{ id: "chats.selectAll", defaultCombo: "mod+a", scope: "chats", descriptionKey: "chats:chatsCommandSelectAll" },
	{ id: "chats.clearSelection", defaultCombo: "escape", scope: "chats", descriptionKey: "chats:chatsCommandClearSelection" }
]
