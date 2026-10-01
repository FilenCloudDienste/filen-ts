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
	/** Chats sidebar — accessible name for the conversation list itself (ARIA listbox) */
	chatsListLabel: "Conversations",
	/** Chats sidebar — search box placeholder and accessible label (filters by name/participant) */
	chatsSearch: "Search conversations",
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
	/** Thread header — participant count under a group conversation's name (singular) */
	chatHeaderParticipants_one: "{{count}} participant",
	/** Thread header — participant count under a group conversation's name (plural) */
	chatHeaderParticipants_other: "{{count}} participants",
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
	/** Message — small marker under an edited message's bubble */
	chatMessageEdited: "Edited",
	/** Message — placeholder body for a message that could not be decrypted */
	chatMessageUndecryptable: "Message could not be decrypted",
	/** Message — sub-line under an own message whose send is still queued/in flight (send outbox) */
	chatMessageSending: "Sending…",
	/** Message — sub-line under an own message whose send failed after exhausting its retry budget */
	chatMessageFailed: "Not sent",
	/** Message — prefix on the compact reply-to reference line above a reply */
	chatReplyingTo: "Replying to {{name}}",
	/** Message — sender label on the reply reference above a reply's bubble, followed by a snippet of the quoted message */
	chatReplyReferenceSender: "{{name}}:",
	/** Message — stands in for the sender's name when the quoted message is your own */
	chatSenderYou: "You",
	/** Composer — reply banner title when replying to one of your own messages */
	chatReplyingToSelf: "Replying to yourself",
	/** Message row / conversation row — replaces a blocked sender's message body and the list preview line */
	chatMessageHiddenBlocked: "Message hidden",
	/** Message row — reveals a hidden blocked-sender message for this session */
	chatMessageHiddenBlockedShow: "Show",
	/** Thread — screen-reader-only announcement when a message arrives from someone else; {{name}} is its sender */
	chatNewMessageAnnouncement_one: "New message from {{name}}",
	/** Thread — screen-reader-only announcement when messages arrive from someone else (plural) */
	chatNewMessageAnnouncement_other: "{{count}} new messages from {{name}}",
	/** Thread — screen-reader-only announcement when one batch of arriving messages comes from several senders, so naming one would misattribute the others */
	chatNewMessagesMixedAnnouncement: "{{count}} new messages",
	/** Message — rendered mention label for @everyone */
	chatMentionEveryone: "everyone",
	/** Message — rendered mention label for an unresolved participant */
	chatMentionUnknown: "unknown",

	// ── Time headers ───────────────────────────────────────────────────────────
	/** Thread — time header above messages sent today; {{time}} is the clock time */
	chatTimeHeaderToday: "Today {{time}}",
	/** Thread — time header above messages sent yesterday; {{time}} is the clock time */
	chatTimeHeaderYesterday: "Yesterday {{time}}",
	/** Thread — time header above older messages; {{date}} is the full localized date, {{time}} the clock time */
	chatTimeHeaderDate: "{{date}} {{time}}",

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
	/** Participants dialog — inline marker appended to a blocked participant's email */
	chatParticipantBlockedMarker: "Blocked",
	/** Participants dialog — shown when the conversation has no other participants */
	chatParticipantsEmpty: "No other participants",
	/** Remove-participant confirm — body copy */
	chatParticipantRemoveDialogBody: "{{email}} will lose access to this conversation.",
	/** Add-participants dialog — body copy */
	chatParticipantsAddDialogBody: "Choose one or more contacts to add to this conversation.",
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
	/** Filen-link previewable card — accessible label on the click-to-open-preview control */
	chatEmbedOpenPreview: "Open preview of {{name}}",
	/** Filen-link card — accessible label for a non-previewable file / directory link's new-tab open control */
	chatEmbedOpenNewTab: "Open {{name}} in a new tab",
	/** Composer attach menu — trigger button accessible label */
	chatComposerAttach: "Attach",
	/** Composer attach menu — trigger tooltip when disabled for a non-Pro account (pre-gated) */
	chatComposerAttachPremiumRequired: "Attachments require a Pro subscription",
	/** Composer — toast when files are dropped on the composer while an earlier attachment is still uploading */
	chatComposerAttachInProgress: "Wait for the current attachment to finish uploading",
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
	chatTypingSeveral: "Several people are typing…",

	// ── Activity toasts (lib/activity) ──────────────────────────────────────
	// The running line of an action and how it ended, in the toast that shows it. `_one` names the one
	// conversation (or participant), `_other` counts them; a partial result counts the ones that succeeded.
	/** Activity toast — marking conversations as read running; one item named ({{name}}) */
	chatsMarkReadRunning_one: "Marking {{name}} as read",
	/** Activity toast — marking conversations as read running; {{count}} items */
	chatsMarkReadRunning_other: "Marking {{count}} conversations as read",
	/** Activity toast — marking conversations as read finished; one item named ({{name}}) */
	chatsMarkReadDone_one: "Marked {{name}} as read",
	/** Activity toast — marking conversations as read finished; {{count}} items */
	chatsMarkReadDone_other: "Marked {{count}} conversations as read",
	/** Activity toast — marking conversations as read failed for every item; one item named ({{name}}) */
	chatsMarkReadFailed_one: "Couldn't mark {{name}} as read",
	/** Activity toast — marking conversations as read failed for every item; {{count}} items */
	chatsMarkReadFailed_other: "Couldn't mark {{count}} conversations as read",
	/** Activity toast — marking conversations as read partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMarkReadPartial_one: "Marked {{count}} conversation as read, {{failed}} failed",
	/** Activity toast — marking conversations as read partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMarkReadPartial_other: "Marked {{count}} conversations as read, {{failed}} failed",
	/** Activity toast — muting conversations running; one item named ({{name}}) */
	chatsMuteRunning_one: "Muting {{name}}",
	/** Activity toast — muting conversations running; {{count}} items */
	chatsMuteRunning_other: "Muting {{count}} conversations",
	/** Activity toast — muting conversations finished; one item named ({{name}}) */
	chatsMuteDone_one: "Muted {{name}}",
	/** Activity toast — muting conversations finished; {{count}} items */
	chatsMuteDone_other: "Muted {{count}} conversations",
	/** Activity toast — muting conversations failed for every item; one item named ({{name}}) */
	chatsMuteFailed_one: "Couldn't mute {{name}}",
	/** Activity toast — muting conversations failed for every item; {{count}} items */
	chatsMuteFailed_other: "Couldn't mute {{count}} conversations",
	/** Activity toast — muting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMutePartial_one: "Muted {{count}} conversation, {{failed}} failed",
	/** Activity toast — muting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMutePartial_other: "Muted {{count}} conversations, {{failed}} failed",
	/** Activity toast — unmuting conversations running; one item named ({{name}}) */
	chatsUnmuteRunning_one: "Unmuting {{name}}",
	/** Activity toast — unmuting conversations running; {{count}} items */
	chatsUnmuteRunning_other: "Unmuting {{count}} conversations",
	/** Activity toast — unmuting conversations finished; one item named ({{name}}) */
	chatsUnmuteDone_one: "Unmuted {{name}}",
	/** Activity toast — unmuting conversations finished; {{count}} items */
	chatsUnmuteDone_other: "Unmuted {{count}} conversations",
	/** Activity toast — unmuting conversations failed for every item; one item named ({{name}}) */
	chatsUnmuteFailed_one: "Couldn't unmute {{name}}",
	/** Activity toast — unmuting conversations failed for every item; {{count}} items */
	chatsUnmuteFailed_other: "Couldn't unmute {{count}} conversations",
	/** Activity toast — unmuting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsUnmutePartial_one: "Unmuted {{count}} conversation, {{failed}} failed",
	/** Activity toast — unmuting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsUnmutePartial_other: "Unmuted {{count}} conversations, {{failed}} failed",
	/** Activity toast — deleting conversations running; one item named ({{name}}) */
	chatsDeleteRunning_one: "Deleting {{name}}",
	/** Activity toast — deleting conversations running; {{count}} items */
	chatsDeleteRunning_other: "Deleting {{count}} conversations",
	/** Activity toast — deleting conversations finished; one item named ({{name}}) */
	chatsDeleteDone_one: "Deleted {{name}}",
	/** Activity toast — deleting conversations finished; {{count}} items */
	chatsDeleteDone_other: "Deleted {{count}} conversations",
	/** Activity toast — deleting conversations failed for every item; one item named ({{name}}) */
	chatsDeleteFailed_one: "Couldn't delete {{name}}",
	/** Activity toast — deleting conversations failed for every item; {{count}} items */
	chatsDeleteFailed_other: "Couldn't delete {{count}} conversations",
	/** Activity toast — deleting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsDeletePartial_one: "Deleted {{count}} conversation, {{failed}} failed",
	/** Activity toast — deleting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsDeletePartial_other: "Deleted {{count}} conversations, {{failed}} failed",
	/** Activity toast — leaving conversations running; one item named ({{name}}) */
	chatsLeaveRunning_one: "Leaving {{name}}",
	/** Activity toast — leaving conversations running; {{count}} items */
	chatsLeaveRunning_other: "Leaving {{count}} conversations",
	/** Activity toast — leaving conversations finished; one item named ({{name}}) */
	chatsLeaveDone_one: "Left {{name}}",
	/** Activity toast — leaving conversations finished; {{count}} items */
	chatsLeaveDone_other: "Left {{count}} conversations",
	/** Activity toast — leaving conversations failed for every item; one item named ({{name}}) */
	chatsLeaveFailed_one: "Couldn't leave {{name}}",
	/** Activity toast — leaving conversations failed for every item; {{count}} items */
	chatsLeaveFailed_other: "Couldn't leave {{count}} conversations",
	/** Activity toast — leaving conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsLeavePartial_one: "Left {{count}} conversation, {{failed}} failed",
	/** Activity toast — leaving conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsLeavePartial_other: "Left {{count}} conversations, {{failed}} failed",
	/** Activity toast — removing participants from a conversation running; one item named ({{name}}) */
	chatParticipantsRemoveRunning_one: "Removing {{name}}",
	/** Activity toast — removing participants from a conversation running; {{count}} items */
	chatParticipantsRemoveRunning_other: "Removing {{count}} participants",
	/** Activity toast — removing participants from a conversation finished; one item named ({{name}}) */
	chatParticipantsRemoveDone_one: "Removed {{name}}",
	/** Activity toast — removing participants from a conversation finished; {{count}} items */
	chatParticipantsRemoveDone_other: "Removed {{count}} participants",
	/** Activity toast — removing participants from a conversation failed for every item; one item named ({{name}}) */
	chatParticipantsRemoveFailed_one: "Couldn't remove {{name}}",
	/** Activity toast — removing participants from a conversation failed for every item; {{count}} items */
	chatParticipantsRemoveFailed_other: "Couldn't remove {{count}} participants",
	/** Activity toast — removing participants from a conversation partly failed; {{count}} succeeded, {{failed}} failed */
	chatParticipantsRemovePartial_one: "Removed {{count}} participant, {{failed}} failed",
	/** Activity toast — removing participants from a conversation partly failed; {{count}} succeeded, {{failed}} failed */
	chatParticipantsRemovePartial_other: "Removed {{count}} participants, {{failed}} failed"
} as const
