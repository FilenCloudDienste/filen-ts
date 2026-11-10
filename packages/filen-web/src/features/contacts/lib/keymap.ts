import type { ActionDef } from "@/lib/keymap/registry"

// The contacts page's commands. Escape, Mod+A, Mod+F, N and Delete/Backspace mirror drive's, notes' and chats': only
// one of those pages is ever mounted at a time. The row commands act on the selection, or on the focused row when
// nothing is selected, and only on rows of the section they belong to (remove and block on contacts, accept and deny
// on incoming requests). Unassigned: block, accept, deny (a stray key acting on someone else is costly) and the section
// switch, which has no free chord off the browser's own.
export const CONTACTS_ACTIONS: readonly ActionDef[] = [
	{ id: "contacts.clearSelection", defaultCombo: "escape", scope: "contacts", descriptionKey: "common:clearSelection" },
	{ id: "contacts.selectAll", defaultCombo: "mod+a", scope: "contacts", descriptionKey: "contacts:contactsCommandSelectAll" },
	{ id: "contacts.search", defaultCombo: "mod+f", scope: "contacts", descriptionKey: "contacts:contactsSearchPlaceholder" },
	{ id: "contacts.add", defaultCombo: "n", scope: "contacts", descriptionKey: "contacts:contactsActionAdd" },
	{
		id: "contacts.message",
		defaultCombo: "mod+enter",
		scope: "contacts",
		descriptionKey: "contacts:contactsCommandMessage",
		hintKey: "contacts:contactsKeyHintFocused"
	},
	{
		id: "contacts.remove",
		defaultCombo: "delete,backspace",
		scope: "contacts",
		descriptionKey: "contacts:contactsCommandRemove",
		hintKey: "contacts:contactsKeyHintFocused"
	},
	{
		id: "contacts.block",
		defaultCombo: "",
		scope: "contacts",
		descriptionKey: "contacts:contactsCommandBlock",
		hintKey: "contacts:contactsKeyHintFocused"
	},
	{
		id: "contacts.accept",
		defaultCombo: "",
		scope: "contacts",
		descriptionKey: "contacts:contactsCommandAccept",
		hintKey: "contacts:contactsKeyHintFocused"
	},
	{
		id: "contacts.deny",
		defaultCombo: "",
		scope: "contacts",
		descriptionKey: "contacts:contactsCommandDeny",
		hintKey: "contacts:contactsKeyHintFocused"
	},
	{ id: "contacts.nextSection", defaultCombo: "", scope: "contacts", descriptionKey: "contacts:contactsCommandNextSection" },
	{ id: "contacts.previousSection", defaultCombo: "", scope: "contacts", descriptionKey: "contacts:contactsCommandPreviousSection" }
]
