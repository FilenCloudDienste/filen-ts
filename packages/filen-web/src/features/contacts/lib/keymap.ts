import type { ActionDef } from "@/lib/keymap/registry"

// Escape is deliberately shared with drive/notes/chats/photos — only one of those surfaces is ever
// mounted at a time.
export const CONTACTS_ACTIONS: readonly ActionDef[] = [
	{ id: "contacts.clearSelection", defaultCombo: "escape", scope: "contacts", descriptionKey: "contacts:contactsCommandClearSelection" }
]
