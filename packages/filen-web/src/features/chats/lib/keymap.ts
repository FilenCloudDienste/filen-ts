import type { ActionDef } from "@/lib/keymap/registry"

// The chats surface's commands, in three layers that focus keeps apart:
// - the conversation list (chatsSidebar.tsx): select all and delete/leave act only with focus in the list (ref-scoped),
//   the rest page-wide outside fields. Next/previous conversation also work in the composer (Slack's Alt+↑/↓), on a
//   modifier chord the textarea has no use for.
// - the composer (composer.tsx): its keydown matches these combos itself, in the textarea only.
// - the thread (messageThread.tsx): Home/End and the message keys act with focus in the thread only, the message keys
//   on the focused message (↑/↓ move between messages).
// Unassigned where no key is free or a stray press would be costly: mark read (Shift+Esc is Chrome's task manager),
// mute, participants, attach from Cloud Drive, retry and remove a failed send.
export const CHATS_ACTIONS: readonly ActionDef[] = [
	{ id: "chats.selectAll", defaultCombo: "mod+a", scope: "chats", descriptionKey: "chats:chatsCommandSelectAll" },
	{ id: "chats.clearSelection", defaultCombo: "escape", scope: "chats", descriptionKey: "common:clearSelection" },
	{ id: "chats.newChat", defaultCombo: "n", scope: "chats", descriptionKey: "chats:chatsSidebarNewChat" },
	{ id: "chats.search", defaultCombo: "mod+f", scope: "chats", descriptionKey: "chats:chatsSearch" },
	{ id: "chats.nextChat", defaultCombo: "alt+arrowdown", scope: "chats", descriptionKey: "chats:chatsCommandNextChat" },
	{ id: "chats.previousChat", defaultCombo: "alt+arrowup", scope: "chats", descriptionKey: "chats:chatsCommandPreviousChat" },
	{ id: "chats.nextUnread", defaultCombo: "alt+shift+arrowdown", scope: "chats", descriptionKey: "chats:chatsCommandNextUnread" },
	{ id: "chats.previousUnread", defaultCombo: "alt+shift+arrowup", scope: "chats", descriptionKey: "chats:chatsCommandPreviousUnread" },
	{ id: "chats.rename", defaultCombo: "f2", scope: "chats", descriptionKey: "chats:chatActionRename" },
	{ id: "chats.markRead", defaultCombo: "", scope: "chats", descriptionKey: "chats:chatActionMarkRead" },
	{ id: "chats.mute", defaultCombo: "", scope: "chats", descriptionKey: "chats:chatsCommandToggleMute" },
	{ id: "chats.participants", defaultCombo: "", scope: "chats", descriptionKey: "chats:chatActionParticipants" },
	{
		id: "chats.deleteSelected",
		defaultCombo: "delete,backspace",
		scope: "chats",
		descriptionKey: "chats:chatsCommandDeleteOrLeave",
		hintKey: "chats:chatsKeyHintList"
	},
	{
		id: "chats.jumpToLatest",
		defaultCombo: "end",
		scope: "chats",
		descriptionKey: "chats:chatsCommandJumpToLatest",
		hintKey: "chats:chatsKeyHintThread"
	},
	{
		id: "chats.jumpToOldest",
		defaultCombo: "home",
		scope: "chats",
		descriptionKey: "chats:chatsCommandJumpToOldest",
		hintKey: "chats:chatsKeyHintThread"
	},
	{
		id: "chats.composer.send",
		defaultCombo: "enter",
		scope: "chats",
		descriptionKey: "chats:chatComposerSend",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.composer.newline",
		defaultCombo: "shift+enter",
		scope: "chats",
		descriptionKey: "chats:chatsCommandNewline",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.composer.editLast",
		defaultCombo: "arrowup",
		scope: "chats",
		descriptionKey: "chats:chatsCommandEditLast",
		hintKey: "chats:chatsKeyHintComposerEmpty"
	},
	{
		id: "chats.composer.cancel",
		defaultCombo: "escape",
		scope: "chats",
		descriptionKey: "chats:chatsCommandCancelMode",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.composer.attach",
		defaultCombo: "mod+shift+u",
		scope: "chats",
		descriptionKey: "chats:chatComposerAttachUpload",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.composer.attachFromDrive",
		defaultCombo: "",
		scope: "chats",
		descriptionKey: "chats:chatComposerAttachFromDrive",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.composer.inlineCode",
		defaultCombo: "mod+e",
		scope: "chats",
		descriptionKey: "chats:chatsCommandInlineCode",
		hintKey: "chats:chatsKeyHintComposer"
	},
	{
		id: "chats.message.reply",
		defaultCombo: "r",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionReply",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.edit",
		defaultCombo: "e",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionEdit",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.copy",
		defaultCombo: "mod+c",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionCopy",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.delete",
		defaultCombo: "delete,backspace",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionDelete",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.retry",
		defaultCombo: "",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionRetry",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.remove",
		defaultCombo: "",
		scope: "chats",
		descriptionKey: "chats:chatMessageActionRemove",
		hintKey: "chats:chatsKeyHintMessage"
	},
	{
		id: "chats.message.menu",
		defaultCombo: "shift+f10",
		scope: "chats",
		descriptionKey: "chats:chatMessageMoreActions",
		hintKey: "chats:chatsKeyHintMessage"
	}
]
