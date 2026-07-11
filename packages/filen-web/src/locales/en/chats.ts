// English source catalog — "chats" namespace: the read-only chats module shell (contextual sidebar
// conversation list, conversation rows, the message thread with its burst-grouped rows, day
// separators, reply-to lines, and the disabled composer placeholder strip). Same typed-catalog rules
// as common/errors/auth/drive/contacts/notes: flat `as const` object, camelCase keys, no literal '.'
// or ':' (real i18next namespaces, keySeparator/nsSeparator both ON). `moduleChats` (the icon-rail
// label) stays in "common" — not duplicated here. Wording mirrors filen-mobile's chats feature and the
// legacy web where an equivalent surface exists. Composer/send copy is intentionally minimal here —
// the real composer lands in a later wave; this wave only renders a disabled placeholder strip.
export const chats = {
	// ── Sidebar ─────────────────────────────────────────────────────────────────
	/** Chats sidebar — header title over the conversation list column */
	chatsSidebarTitle: "Chats",
	/** Chats sidebar — search box placeholder and accessible label (filters by name/participant) */
	chatsSearch: "Search conversations",
	/** Chats sidebar — clears the search box */
	chatsSearchClear: "Clear search",
	/** Chats sidebar — title shown when the list is empty on a fresh account */
	chatsEmptyTitle: "No conversations yet",
	/** Chats sidebar — description under the empty title */
	chatsEmptyDescription: "Your conversations will appear here.",
	/** Chats sidebar — title shown when a search matches nothing */
	chatsSearchEmptyTitle: "No matches",
	/** Chats sidebar — description under the no-matches title */
	chatsSearchEmptyDescription: "No conversations match your search.",
	/** Chats sidebar — shown when the conversation list query fails */
	chatsLoadError: "Couldn't load conversations",
	/** Chats sidebar — icon-rail unread badge accessible label (count of unread conversations/messages) */
	chatsRailUnread: "{{count}} unread",

	// ── Conversation row ─────────────────────────────────────────────────────────
	/** Conversation row — preview-line fallback when a conversation has no readable last message */
	chatNoMessages: "No messages yet",
	/** Conversation row — accessible label on the muted indicator */
	chatMuted: "Muted",
	/** Conversation row — accessible label on the per-row unread indicator */
	chatUnread: "Unread",
	/** Conversation row — display fallback for a conversation whose key didn't decrypt */
	chatUndecryptable: "Encrypted conversation",

	// ── Thread ───────────────────────────────────────────────────────────────────
	/** Thread — prompt in the main card when no conversation is selected */
	chatsSelectPrompt: "Select a conversation",
	/** Thread — description under the select prompt */
	chatsSelectPromptDescription: "Choose a conversation to read its messages.",
	/** Thread — shown while the conversation list (which resolves the selected chat) is still loading */
	chatsLoadingThread: "Loading conversation…",
	/** Thread — shown when the message list query fails */
	chatThreadLoadError: "Couldn't load messages",
	/** Thread — shown when a resolved conversation has no messages yet */
	chatThreadEmpty: "No messages in this conversation yet.",
	/** Thread — accessible label on the older-messages loading spinner at the top of the list */
	chatLoadingOlder: "Loading earlier messages…",
	/** Message — trailing marker on an edited message */
	chatMessageEdited: "(edited)",
	/** Message — placeholder body for a message that could not be decrypted */
	chatMessageUndecryptable: "Message could not be decrypted",
	/** Message — prefix on the compact reply-to reference line above a reply */
	chatReplyingTo: "Replying to {{name}}",
	/** Message — rendered mention label for @everyone */
	chatMentionEveryone: "everyone",
	/** Message — rendered mention label for an unresolved participant */
	chatMentionUnknown: "unknown",

	// ── Day separators ─────────────────────────────────────────────────────────
	/** Thread — day separator label for messages sent today */
	chatDayToday: "Today",
	/** Thread — day separator label for messages sent yesterday */
	chatDayYesterday: "Yesterday",

	// ── Composer placeholder (send lands in a later wave) ─────────────────────────
	/** Thread — placeholder text inside the disabled composer strip */
	chatComposerPlaceholder: "Message",
	/** Thread — note explaining the composer is not yet interactive */
	chatComposerUnavailable: "Sending isn't available yet",

	// ── Conversation actions (C2 — no send/composer) ──────────────────────────────
	/** Sidebar — opens the new-conversation contact picker */
	chatsSidebarNewChat: "New chat",
	/** Row / thread header — accessible label on the ⋯ / ⋮ menu trigger */
	chatItemMenuTrigger: "Conversation menu",
	/** Conversation menu — marks the conversation as read (shown only while it has unread messages) */
	chatActionMarkRead: "Mark as read",
	/** Conversation menu — mutes the conversation */
	chatActionMute: "Mute",
	/** Conversation menu — unmutes an already-muted conversation */
	chatActionUnmute: "Unmute",
	/** Conversation menu — opens the participants dialog */
	chatActionParticipants: "Participants",
	/** Conversation menu — renames the conversation (opens chatRenameDialog, owner-only) */
	chatActionRename: "Rename",
	/** Conversation menu — permanently deletes the conversation (owner-only) */
	chatActionDelete: "Delete",
	/** Conversation menu — a non-owner participant removes themselves (opens chatLeaveDialog) */
	chatActionLeave: "Leave",
	/** Action error — shown when a non-owner attempts an owner-only conversation action */
	chatOwnerOnlyError: "Only the conversation owner can do this.",
	/** Action error — defense-in-depth guard, createChat is never called with an empty selection */
	chatCreateNoContactsError: "Choose at least one contact.",

	// ── Create-conversation dialog ─────────────────────────────────────────────────
	/** Create-chat dialog — heading */
	chatCreateDialogTitle: "New chat",
	/** Create-chat dialog — body copy above the contact list */
	chatCreateDialogBody: "Choose one or more contacts to start a conversation.",
	/** Create-chat dialog — submit button */
	chatCreateDialogSubmit: "Create",

	// ── Rename dialog ────────────────────────────────────────────────────────────
	/** Rename dialog — heading */
	chatRenameDialogTitle: "Rename conversation",
	/** Rename dialog — body copy */
	chatRenameDialogBody: "Enter a new name.",
	/** Rename dialog — field label */
	chatRenameDialogLabel: "Name",
	/** Rename dialog — submit button */
	chatRenameDialogSubmit: "Rename",

	// ── Delete / leave dialogs ───────────────────────────────────────────────────
	/** Delete dialog — heading */
	chatDeleteDialogTitle: "Delete conversation?",
	/** Delete dialog — body copy */
	chatDeleteDialogBody: "Are you sure you want to permanently delete this conversation? This cannot be undone.",
	/** Leave dialog — heading */
	chatLeaveDialogTitle: "Leave conversation?",
	/** Leave dialog — body copy */
	chatLeaveDialogBody: "Are you sure you want to leave this conversation? You will lose access to it.",

	// ── Participants dialog ──────────────────────────────────────────────────────
	/** Participants dialog — heading (list mode) */
	chatParticipantsDialogTitle: "Participants",
	/** Participants dialog — owner-only "add participants" button */
	chatParticipantsAddAction: "Add participants",
	/** Participants dialog — accessible label on the crown icon next to the owner's row */
	chatParticipantsOwnerBadge: "Owner",
	/** Participants dialog — accessible label on a manageable row's remove button */
	chatParticipantRemoveAction: "Remove {{email}}",
	/** Participants dialog — shown when the conversation has no other participants */
	chatParticipantsEmpty: "No other participants",
	/** Remove-participant confirm — heading */
	chatParticipantRemoveDialogTitle: "Remove participant?",
	/** Remove-participant confirm — confirm button */
	chatParticipantRemoveDialogConfirm: "Remove",
	/** Remove-participant confirm — body copy */
	chatParticipantRemoveDialogBody: "{{email}} will lose access to this conversation.",
	/** Add-participants dialog — heading (add mode) */
	chatParticipantsAddDialogTitle: "Add participants",
	/** Add-participants dialog — body copy */
	chatParticipantsAddDialogBody: "Choose one or more contacts to add to this conversation.",
	/** Add-participants dialog — submit button */
	chatParticipantsAddSubmit: "Add",
	/** Add-participants dialog — shown when every contact is already a participant */
	chatParticipantsAddEmpty: "No contacts available to add",

	// ── Message menu (copy/delete only — reply/edit land with the composer wave) ─────
	/** Message menu — copies the message text to the clipboard */
	chatMessageActionCopy: "Copy",
	/** Message menu — deletes the message (sender-only, opens chatMessageDeleteDialog) */
	chatMessageActionDelete: "Delete",
	/** Toast shown after a successful message-text copy */
	chatMessageCopyToast: "Copied to clipboard",
	/** Message delete confirm — heading */
	chatMessageDeleteDialogTitle: "Delete message?",
	/** Message delete confirm — body copy */
	chatMessageDeleteDialogBody: "Are you sure you want to delete this message? This cannot be undone."
} as const
