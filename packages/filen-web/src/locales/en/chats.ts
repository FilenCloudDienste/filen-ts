// English source catalog — "chats" namespace: the chats module shell (contextual sidebar conversation
// list, conversation rows, the message thread with its burst-grouped rows, day separators, reply-to
// lines, message menus, and the composer with its reply/edit/send affordances). Same typed-catalog rules
// as common/errors/auth/drive/contacts/notes: flat `as const` object, camelCase keys, no literal '.'
// or ':' (real i18next namespaces, keySeparator/nsSeparator both ON). `moduleChats` (the icon-rail
// label) stays in "common" — not duplicated here. Wording mirrors filen-mobile's chats feature and the
// legacy web where an equivalent surface exists.
export const chats = {
	// ── Sidebar ─────────────────────────────────────────────────────────────────
	/** Chats sidebar — header title over the conversation list column */
	chatsSidebarTitle: "Chats",
	/** Chats sidebar — accessible label on the trailing-edge drag handle that resizes the sidebar */
	chatsSidebarResize: "Resize sidebar",
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

	// ── Conversation row ─────────────────────────────────────────────────────────
	/** Conversation row — preview-line fallback when a conversation has no readable last message */
	chatNoMessages: "No messages yet",
	/** Conversation row — accessible label on the muted indicator */
	chatMuted: "Muted",
	/** Conversation row — accessible label on the per-row unread indicator */
	chatUnread: "Unread",
	/** Conversation row — accessible label on the numeric unread badge (singular) */
	chatUnreadCount_one: "{{count}} unread message",
	/** Conversation row — accessible label on the numeric unread badge (plural) */
	chatUnreadCount_other: "{{count}} unread messages",
	/** Conversation row — display fallback for a conversation whose key didn't decrypt */
	chatUndecryptable: "Encrypted conversation",
	/** Conversation row / thread header — title fallback for an unnamed conversation where every
	 *  other participant has left and only the current user remains */
	chatJustYou: "Just you",

	// ── Thread ───────────────────────────────────────────────────────────────────
	/** Thread — prompt in the main card when no conversation is selected */
	chatsSelectPrompt: "Select a conversation",
	/** Thread — description under the select prompt */
	chatsSelectPromptDescription: "Choose a conversation to read its messages.",
	/** Thread — shown while the conversation list (which resolves the selected chat) is still loading */
	chatsLoadingThread: "Loading conversation…",
	/** Thread — shown when the message list query fails */
	chatThreadLoadError: "Couldn't load messages",
	/** Chat surface — banner pinned above the conversation while the realtime socket is reconnecting */
	chatReconnecting: "Reconnecting…",
	/** Thread — shown when a resolved conversation has no messages yet */
	chatThreadEmpty: "No messages in this conversation yet.",
	/** Thread — accessible label on the older-messages loading spinner at the top of the list */
	chatLoadingOlder: "Loading earlier messages…",
	/** Thread — label on the one-time "New" divider inserted at the first unread message; click marks read */
	chatUnreadDivider: "New",
	/** Thread — accessible label on the floating scroll-to-bottom pill (singular) */
	chatScrollToBottom_one: "{{count}} new message",
	/** Thread — accessible label on the floating scroll-to-bottom pill (plural) */
	chatScrollToBottom_other: "{{count}} new messages",
	/** Thread — visible text on the floating scroll-to-bottom pill (singular) */
	chatNewMessagesCount_one: "{{count}} new",
	/** Thread — visible text on the floating scroll-to-bottom pill (plural) */
	chatNewMessagesCount_other: "{{count}} new",
	/** Message — trailing marker on an edited message */
	chatMessageEdited: "(edited)",
	/** Message — placeholder body for a message that could not be decrypted */
	chatMessageUndecryptable: "Message could not be decrypted",
	/** Message — sub-line under an own message whose send is still queued/in flight (send outbox) */
	chatMessageSending: "Sending…",
	/** Message — sub-line under an own message whose send failed after exhausting its retry budget */
	chatMessageFailed: "Not sent",
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

	// ── Composer ──────────────────────────────────────────────────────────────────
	/** Composer — textarea placeholder + accessible label */
	chatComposerPlaceholder: "Message",
	/** Composer — accessible label on the send button */
	chatComposerSend: "Send message",
	/** Composer — accessible label on the send button while editing a message */
	chatComposerSaveEdit: "Save edit",
	/** Composer — banner label while editing an existing message */
	chatComposerEditing: "Editing message",
	/** Composer — accessible label on the button that cancels an in-progress reply */
	chatComposerCancelReply: "Cancel reply",
	/** Composer — accessible label on the button that cancels an in-progress edit */
	chatComposerCancelEdit: "Cancel edit",
	/** Composer — shown under the input when the message exceeds the maximum length */
	chatComposerOverLimit: "Message is too long (max {{max}} characters)",
	/** Composer — toast when a queued send couldn't be written to disk (survives in memory only) */
	chatMessageNotSaved: "Message couldn't be saved to this device",

	// ── Conversation actions ──────────────────────────────
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

	// ── Multi-select / bulk actions ────────────────────────────────────────────
	/** Keymap — mod+a: selects every currently-visible conversation */
	chatsCommandSelectAll: "Select all conversations",
	/** Keymap — Escape: clears the active multi-selection */
	chatsCommandClearSelection: "Clear selection",
	/** Bulk-action bar — accessible label on the clear-selection (X) button */
	chatsSelectionCount_one: "{{count}} selected",
	/** Bulk-action bar — accessible label on the clear-selection (X) button (plural) */
	chatsSelectionCount_other: "{{count}} selected",
	/** Bulk-action toast — every targeted conversation succeeded */
	chatsBulkActionComplete_one: "{{count}} conversation updated",
	/** Bulk-action toast — every targeted conversation succeeded (plural) */
	chatsBulkActionComplete_other: "{{count}} conversations updated",
	/** Bulk-action toast — a partial failure */
	chatsBulkActionCompleteWithFailures_one: "{{count}} conversation updated, {{failed}} failed",
	/** Bulk-action toast — a partial failure (plural) */
	chatsBulkActionCompleteWithFailures_other: "{{count}} conversations updated, {{failed}} failed",
	/** Bulk delete confirm — heading */
	chatsDeleteSelectedConfirmTitle: "Delete conversations?",
	/** Bulk delete confirm — body copy */
	chatsDeleteSelectedConfirmBody_one: "Are you sure you want to permanently delete this conversation? This cannot be undone.",
	/** Bulk delete confirm — body copy (plural) */
	chatsDeleteSelectedConfirmBody_other:
		"Are you sure you want to permanently delete these {{count}} conversations? This cannot be undone.",
	/** Bulk leave confirm — heading */
	chatsLeaveSelectedConfirmTitle: "Leave conversations?",
	/** Bulk leave confirm — body copy */
	chatsLeaveSelectedConfirmBody_one: "Are you sure you want to leave this conversation? You will lose access to it.",
	/** Bulk leave confirm — body copy (plural) */
	chatsLeaveSelectedConfirmBody_other: "Are you sure you want to leave these {{count}} conversations? You will lose access to them.",

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
	/** Participants dialog — owner-only bulk-remove footer button (list mode, 1+ rows selected) */
	chatParticipantsRemoveSelectedAction_one: "Remove {{count}} participant",
	/** Participants dialog — owner-only bulk-remove footer button (plural) */
	chatParticipantsRemoveSelectedAction_other: "Remove {{count}} participants",
	/** Bulk remove-participants confirm — heading */
	chatParticipantRemoveSelectedDialogTitle: "Remove participants?",
	/** Bulk remove-participants confirm — body copy */
	chatParticipantRemoveSelectedDialogBody_one: "{{count}} participant will lose access to this conversation.",
	/** Bulk remove-participants confirm — body copy (plural) */
	chatParticipantRemoveSelectedDialogBody_other: "{{count}} participants will lose access to this conversation.",
	/** Bulk remove-participants toast — every targeted participant succeeded */
	chatParticipantsBulkRemoveComplete_one: "{{count}} participant removed",
	/** Bulk remove-participants toast — every targeted participant succeeded (plural) */
	chatParticipantsBulkRemoveComplete_other: "{{count}} participants removed",
	/** Bulk remove-participants toast — a partial failure */
	chatParticipantsBulkRemoveCompleteWithFailures_one: "{{count}} participant removed, {{failed}} failed",
	/** Bulk remove-participants toast — a partial failure (plural) */
	chatParticipantsBulkRemoveCompleteWithFailures_other: "{{count}} participants removed, {{failed}} failed",

	// ── Message menu ─────────────────────────────────────────────────────────────
	/** Hover action bar — accessible label on the floating per-message toolbar */
	chatMessageActionsLabel: "Message actions",
	/** Hover action bar — the ⋯ overflow trigger that opens the full message menu */
	chatMessageMoreActions: "More actions",
	/** Message menu — quotes the message in the composer as a reply target */
	chatMessageActionReply: "Reply",
	/** Message menu — loads an own message's text into the composer for an in-place edit (sender-only) */
	chatMessageActionEdit: "Edit",
	/** Message menu — copies the message text to the clipboard */
	chatMessageActionCopy: "Copy",
	/** Message menu — deletes the message (sender-only, opens chatMessageDeleteDialog) */
	chatMessageActionDelete: "Delete",
	/** Message menu — re-queues a failed send (send outbox), resetting its retry budget */
	chatMessageActionRetry: "Retry",
	/** Message menu — discards a failed send entirely (drops it from the send outbox) */
	chatMessageActionRemove: "Remove",
	/** Message menu — sender-only, only shown on a message with an active embed; turns it back into a plain link */
	chatMessageActionDisableEmbed: "Disable embed",
	/** Message menu — blocks the sender of another person's message (hidden on your own and already-blocked senders) */
	chatMessageActionBlock: "Block user",
	/** Toast shown after a successful message-text copy */
	chatMessageCopyToast: "Copied to clipboard",
	/** Toast shown after successfully blocking a message sender */
	chatMessageBlockedToast: "User blocked",
	/** Message delete confirm — heading */
	chatMessageDeleteDialogTitle: "Delete message?",
	/** Message delete confirm — body copy */
	chatMessageDeleteDialogBody: "Are you sure you want to delete this message? This cannot be undone.",

	// ── Embeds ───────────────────────────────────────────────────────────────────
	/** Filen-link embed card — subtitle under the name for a directory link before it resolves (or on resolution failure) */
	chatEmbedFilenDirectory: "Filen directory",
	/** Filen-link embed card — subtitle under the name for a file link before it resolves (or on resolution failure) */
	chatEmbedFilenFile: "Filen file",
	/** Media embed — accessible label on the loading skeleton while the content-type probe is in flight */
	chatEmbedLoading: "Loading preview…",
	/** Media embed / Filen-link previewable-card — accessible label on the click-to-open-preview control */
	chatEmbedOpenPreview: "Open preview of {{name}}",
	/** Filen-link card — accessible label for a non-previewable file / directory link's new-tab open control */
	chatEmbedOpenNewTab: "Open {{name}} in a new tab",
	/** Composer attach menu — trigger button accessible label */
	chatComposerAttach: "Attach",
	/** Composer attach menu — trigger tooltip when disabled for a non-Pro account (pre-gated) */
	chatComposerAttachPremiumRequired: "Attachments require a Pro subscription",
	/** Composer attach menu — uploads a local file */
	chatComposerAttachUpload: "Upload a file",
	/** Composer attach menu — opens the Drive picker */
	chatComposerAttachFromDrive: "Choose from Drive",
	/** Drive-attach picker — dialog heading */
	chatAttachDriveDialogTitle: "Attach from Drive",
	/** Drive-attach picker — confirm/select hint shown under a selectable file row (not a button, click-to-attach) */
	chatAttachDriveDialogHint: "Click a file to attach it",
	/** External-link trust confirmation — dialog title, shown once per not-yet-trusted domain */
	chatLinkTrustTitle: "Open external link?",
	/** External-link trust confirmation — body, {{domain}} is the link's own hostname */
	chatLinkTrustBody: "This link leads to {{domain}}, outside Filen. You won't be asked again for this domain.",
	/** External-link trust confirmation — confirm button (opens the link in a new tab and remembers the domain) */
	chatLinkTrustConfirm: "Open link",

	// ── Typing indicators ────────────────────────────────────────────────────────
	/** Typing indicator — a single remote user is typing (thread footer + sidebar row preview) */
	chatTypingSingle: "{{name}} is typing…",
	/** Typing indicator — exactly two remote users are typing */
	chatTypingDouble: "{{name}} and {{other}} are typing…",
	/** Typing indicator — three or more remote users are typing */
	chatTypingSeveral: "Several people are typing…"
} as const
