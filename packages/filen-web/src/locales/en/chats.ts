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
	/** Chats sidebar — accessible name for the conversation list itself (the group of its section listboxes) */
	chatsListLabel: "Conversations",
	/** Chats sidebar — collapsible section header over one-to-one conversations */
	chatsSectionDirect: "Direct messages",
	/** Chats sidebar — collapsible section header over group conversations */
	chatsSectionGroups: "Groups",
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
	/** Conversation row — preview line prefixed with its sender ("You" for own messages, the sender's name in a group) */
	chatPreviewWithSender: "{{name}}: {{message}}",
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
	/** Thread — inline notice at the top of the list when loading older messages failed; a Retry button follows */
	chatLoadOlderFailed: "Couldn't load older messages",
	/** Thread — the button beside the failed older-messages notice that loads them again */
	chatLoadOlderRetry: "Retry",
	/** Thread search bar — field placeholder and accessible label */
	chatThreadSearchLabel: "Search this conversation",
	/** Thread search bar — position of the current match among the loaded messages' matches */
	chatThreadSearchPosition: "{{current}} of {{total}}",
	/** Thread search bar — shown when no loaded message matches */
	chatThreadSearchNoResults: "No results",
	/** Thread search bar — moves to the next (older) match */
	chatThreadSearchNext: "Next match",
	/** Thread search bar — moves to the previous (newer) match */
	chatThreadSearchPrevious: "Previous match",
	/** Thread search bar — closes the search */
	chatThreadSearchClose: "Close search",
	/** Thread search bar — loads older messages to continue searching back */
	chatThreadSearchOlder: "Search older messages",
	/** Thread search bar — shown once the whole history is loaded and searched */
	chatThreadSearchAllLoaded: "Searched the whole conversation",
	/** Thread — accessible label of a reply's quote, which scrolls to the message it replies to */
	chatReplyJump: "Go to the original message",
	/** Thread — toast when the message a reply quotes is not in the conversation any more */
	chatReplyJumpNotFound: "The original message isn't available",
	/** Thread header — participant count under a group conversation's name (singular) */
	chatHeaderParticipants_one: "{{count}} participant",
	/** Thread header — participant count under a group conversation's name (plural) */
	chatHeaderParticipants_other: "{{count}} participants",
	/** Thread — label on the one-time "New" divider inserted at the first unread message; click marks read */
	chatUnreadDivider: "New",
	/** Thread — accessible label and tooltip on the "New" divider button; activating it marks the chat read */
	chatUnreadDividerMarkRead: "New messages. Mark as read",
	/** Thread — accessible label on the floating scroll-to-bottom pill (singular) */
	chatScrollToBottom_one: "{{count}} new message",
	/** Thread — accessible label on the floating scroll-to-bottom pill (plural) */
	chatScrollToBottom_other: "{{count}} new messages",
	/** Thread — visible text on the floating scroll-to-bottom pill (singular) */
	chatNewMessagesCount_one: "{{count}} new",
	/** Thread — visible text on the floating scroll-to-bottom pill (plural) */
	chatNewMessagesCount_other: "{{count}} new",
	/** Message — small marker after an edited message's text */
	chatMessageEdited: "Edited",
	/** Message — placeholder body for a message that could not be decrypted */
	chatMessageUndecryptable: "Message could not be decrypted",
	/** Message — sub-line under an own message whose send is still queued/in flight (send outbox) */
	chatMessageSending: "Sending…",
	/** Message — sub-line under an own message whose send failed after exhausting its retry budget */
	chatMessageFailed: "Not sent",
	/** Message — prefix on the compact reply-to reference line above a reply */
	chatReplyingTo: "Replying to {{name}}",
	/** Message — sender label on the reply reference above a reply, followed by a snippet of the quoted message */
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
	chatNewMessageAnnouncementSingle: "New message from {{name}}",
	/** Thread — screen-reader-only announcement when messages arrive from someone else; {{count}} = messages, {{name}} is their sender */
	chatNewMessageAnnouncement_one: "{{count}} new message from {{name}}",
	/** Thread — screen-reader-only announcement when messages arrive from someone else (plural) */
	chatNewMessageAnnouncement_other: "{{count}} new messages from {{name}}",
	/** Thread — screen-reader-only announcement when one batch of arriving messages comes from several senders, so naming one would misattribute the others */
	chatNewMessagesMixedAnnouncement: "{{count}} new messages",
	/** Message — rendered mention label for @everyone */
	chatMentionEveryone: "everyone",
	/** Message — rendered mention label for an unresolved participant */
	chatMentionUnknown: "unknown",
	/** Message — screen-reader-only note on a message that @mentions the reader or @everyone (the row is also tinted) */
	chatMessageMentionsYou: "Mentions you",
	/** Message — screen-reader-only note on a message that replies to one of the reader's messages (the row is also tinted) */
	chatMessageRepliesToYou: "Replies to you",

	// ── Time headers ───────────────────────────────────────────────────────────
	/** Thread — time header above messages sent today; {{time}} is the clock time */
	chatTimeHeaderToday: "Today {{time}}",
	/** Thread — time header above messages sent yesterday; {{time}} is the clock time */
	chatTimeHeaderYesterday: "Yesterday {{time}}",
	/** Thread — time header above older messages; {{date}} is the full localized date, {{time}} the clock time */
	chatTimeHeaderDate: "{{date}} {{time}}",

	// ── Composer ──────────────────────────────────────────────────────────────────
	/** Composer — textarea accessible label */
	chatComposerPlaceholder: "Message",
	/** Composer — textarea placeholder; {{name}} is the conversation's title */
	chatComposerPlaceholderChat: "Message {{name}}",
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
	/** Composer — accessible label on the near-limit character counter (singular) */
	chatComposerCharsRemaining_one: "{{count}} character remaining",
	/** Composer — accessible label on the near-limit character counter (plural) */
	chatComposerCharsRemaining_other: "{{count}} characters remaining",
	/** Composer — accessible label on the character counter once the message is over the limit (singular) */
	chatComposerCharsOver_one: "{{count}} character over the limit",
	/** Composer — accessible label on the character counter once the message is over the limit (plural) */
	chatComposerCharsOver_other: "{{count}} characters over the limit",
	/** Composer — screen-reader announcement when the mention or emoji suggestion list opens (singular) */
	chatComposerSuggestionCount_one: "{{count}} suggestion available",
	/** Composer — screen-reader announcement when the mention or emoji suggestion list opens (plural) */
	chatComposerSuggestionCount_other: "{{count}} suggestions available",
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
	/** Conversation menu — opens the chat info panel (also the thread header's toggle) */
	chatActionParticipants: "Participants",
	/** Conversation menu — renames the conversation (opens chatRenameDialog, owner-only) */
	chatActionRename: "Rename",
	/** Conversation menu — copies the conversation's ID to the clipboard */
	chatActionCopyId: "Copy ID",
	/** Toast shown after copying a conversation's ID */
	chatCopyIdToast: "Conversation ID copied to clipboard",
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
	/** Keymap — opens the conversation below the open one in the list */
	chatsCommandNextChat: "Next conversation",
	/** Keymap — opens the conversation above the open one in the list */
	chatsCommandPreviousChat: "Previous conversation",
	/** Keymap — opens the next conversation below the open one that has unread messages */
	chatsCommandNextUnread: "Next unread conversation",
	/** Keymap — opens the previous conversation above the open one that has unread messages */
	chatsCommandPreviousUnread: "Previous unread conversation",
	/** Keymap — mutes the open (or selected) conversation, or unmutes it when muted */
	chatsCommandToggleMute: "Mute or unmute conversation",
	/** Keymap — deletes the selected (or open) conversations you own, or leaves the ones you don't */
	chatsCommandDeleteOrLeave: "Delete or leave conversations",
	/** Keymap — scrolls the thread to the newest message, or moves focus to it from a focused message */
	chatsCommandJumpToLatest: "Jump to newest message",
	/** Keymap — scrolls the thread to the oldest loaded message, or moves focus to it from a focused message */
	chatsCommandJumpToOldest: "Jump to oldest message",
	/** Keymap — opens the search bar of the open conversation's thread */
	chatsCommandSearchThread: "Search in conversation",
	/** Keymap — inserts a line break in the message being written instead of sending it */
	chatsCommandNewline: "New line",
	/** Keymap — loads your last sent message into the message field to edit it */
	chatsCommandEditLast: "Edit your last message",
	/** Keymap — stops replying to or editing a message */
	chatsCommandCancelMode: "Cancel reply or edit",
	/** Keymap — wraps the selected text in the message field as inline code (backticks) */
	chatsCommandInlineCode: "Inline code",
	/** Keyboard shortcuts — where a shortcut works: with focus in the conversation list */
	chatsKeyHintList: "In the conversation list",
	/** Keyboard shortcuts — where a shortcut works: with focus in the message list of a conversation */
	chatsKeyHintThread: "In the message list",
	/** Keyboard shortcuts — where a shortcut works: with focus anywhere in the open conversation (header, messages or message field) */
	chatsKeyHintConversation: "In the open conversation",
	/** Keyboard shortcuts — where a shortcut works: while typing a message */
	chatsKeyHintComposer: "In the message field",
	/** Keyboard shortcuts — where a shortcut works: in the message field while it is empty */
	chatsKeyHintComposerEmpty: "In an empty message field",
	/** Keyboard shortcuts — where a shortcut works: on the message that has keyboard focus (move between messages with the arrow keys) */
	chatsKeyHintMessage: "On the focused message",
	/** Bulk delete confirm — heading */
	chatsDeleteSelectedConfirmTitle: "Delete conversations?",
	/** Bulk delete confirm — body copy for a single conversation */
	chatsDeleteSelectedConfirmBodySingle: "Are you sure you want to permanently delete this conversation? This cannot be undone.",
	/** Bulk delete confirm — body copy; {{count}} = conversations being deleted */
	chatsDeleteSelectedConfirmBody_one: "Are you sure you want to permanently delete {{count}} conversation? This cannot be undone.",
	/** Bulk delete confirm — body copy (plural) */
	chatsDeleteSelectedConfirmBody_other:
		"Are you sure you want to permanently delete these {{count}} conversations? This cannot be undone.",
	/** Bulk leave confirm — heading */
	chatsLeaveSelectedConfirmTitle: "Leave conversations?",
	/** Bulk leave confirm — body copy for a single conversation */
	chatsLeaveSelectedConfirmBodySingle: "Are you sure you want to leave this conversation? You will lose access to it.",
	/** Bulk leave confirm — body copy; {{count}} = conversations being left */
	chatsLeaveSelectedConfirmBody_one: "Are you sure you want to leave {{count}} conversation? You will lose access to it.",
	/** Bulk leave confirm — body copy (plural) */
	chatsLeaveSelectedConfirmBody_other: "Are you sure you want to leave these {{count}} conversations? You will lose access to them.",

	// ── Chat info panel ──────────────────────────────────────────────────────────
	/** Chat info panel — heading, and the accessible name of its sheet on narrow screens */
	chatInfoTitle: "Chat info",
	/** Chat info panel — label on the mute switch */
	chatInfoMute: "Mute notifications",
	/** Chat info panel — accessible label on a participant row's ⋯ menu (Remove/Block/Unblock); {{name}} = the participant */
	chatInfoParticipantMenu: "Actions for {{name}}",
	/** Chat info panel — inline marker after a blocked participant's name */
	chatParticipantBlockedMarker: "Blocked",
	/** Remove-participant confirm — body copy */
	chatParticipantRemoveDialogBody: "{{email}} will lose access to this conversation.",
	/** Chat info panel — add-participants view, body copy */
	chatParticipantsAddDialogBody: "Choose one or more contacts to add to this conversation.",

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
	/** Message menu — copies the message's ID to the clipboard */
	chatMessageActionCopyId: "Copy ID",
	/** Toast shown after copying a message's ID */
	chatMessageCopyIdToast: "Message ID copied to clipboard",
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
	/** Filen-link card — accessible label for a non-previewable file / directory link's open control */
	chatEmbedOpenLink: "Open {{name}}",
	/** Composer attach menu — trigger button accessible label */
	chatComposerAttach: "Attach",
	/** Composer — accessible label and tooltip of the button that opens the emoji picker, and the picker's own label */
	chatComposerEmoji: "Emoji",
	/** Emoji picker — label and placeholder of the search field */
	chatEmojiPickerSearch: "Search emoji",
	/** Emoji picker — accessible label of the grid while it shows search results */
	chatEmojiPickerResults: "Search results",
	/** Emoji picker — shown when a search matches no emoji */
	chatEmojiPickerNoResults: "No emoji found",
	/** Emoji picker — shown on the recently used tab before any emoji was used */
	chatEmojiPickerNoRecent: "Emoji you use show up here",
	/** Emoji picker tab — recently used emoji */
	chatEmojiCategoryRecent: "Recently used",
	/** Emoji picker tab — the Unicode "Smileys & Emotion" group */
	chatEmojiCategorySmileys: "Smileys & emotion",
	/** Emoji picker tab — the Unicode "People & Body" group */
	chatEmojiCategoryPeople: "People & body",
	/** Emoji picker tab — the Unicode "Animals & Nature" group */
	chatEmojiCategoryNature: "Animals & nature",
	/** Emoji picker tab — the Unicode "Food & Drink" group */
	chatEmojiCategoryFood: "Food & drink",
	/** Emoji picker tab — the Unicode "Travel & Places" group */
	chatEmojiCategoryTravel: "Travel & places",
	/** Emoji picker tab — the Unicode "Activities" group */
	chatEmojiCategoryActivities: "Activities",
	/** Emoji picker tab — the Unicode "Objects" group */
	chatEmojiCategoryObjects: "Objects",
	/** Emoji picker tab — the Unicode "Symbols" group */
	chatEmojiCategorySymbols: "Symbols",
	/** Emoji picker tab — the Unicode "Flags" group */
	chatEmojiCategoryFlags: "Flags",
	/** Emoji picker — accessible label and tooltip of the button that shows the skin tone choices, and of that group */
	chatEmojiSkinTone: "Skin tone",
	/** Emoji picker skin tone choice — the default yellow, no skin tone */
	chatEmojiSkinToneDefault: "Default",
	/** Emoji picker skin tone choice — Fitzpatrick type 1-2 */
	chatEmojiSkinToneLight: "Light",
	/** Emoji picker skin tone choice — Fitzpatrick type 3 */
	chatEmojiSkinToneMediumLight: "Medium-light",
	/** Emoji picker skin tone choice — Fitzpatrick type 4 */
	chatEmojiSkinToneMedium: "Medium",
	/** Emoji picker skin tone choice — Fitzpatrick type 5 */
	chatEmojiSkinToneMediumDark: "Medium-dark",
	/** Emoji picker skin tone choice — Fitzpatrick type 6 */
	chatEmojiSkinToneDark: "Dark",
	/** Emoji picker tab — Filen's own image emoji */
	chatEmojiCategoryCustom: "Filen emoji",
	/** Composer attach menu — trigger tooltip when disabled for a non-Pro account (pre-gated) */
	chatComposerAttachPremiumRequired: "Attachments require a Pro subscription",
	/** Composer — toast when files are dropped on the composer while an earlier attachment is still uploading */
	chatComposerAttachInProgress: "Wait for the current attachment to finish uploading",
	/** Composer — toast title when attaching one file fails; the error is its description. {{name}} = the file's name */
	chatComposerAttachFileFailed: "Couldn't attach {{name}}",
	/** Composer attach menu — uploads a local file */
	chatComposerAttachUpload: "Upload a file",
	/** Composer attach menu — opens the Drive picker */
	chatComposerAttachFromDrive: "Choose from Drive",
	/** Drive-attach picker — dialog heading */
	chatAttachDriveDialogTitle: "Attach from Drive",
	/** Drive-attach picker — confirm/select hint shown under a selectable file row (not a button, click-to-attach) */
	chatAttachDriveDialogHint: "Click a file to attach it",

	// ── Typing indicators ────────────────────────────────────────────────────────
	/** Typing indicator — a single remote user is typing (thread footer + sidebar row preview) */
	chatTypingSingle: "{{name}} is typing…",
	/** Typing indicator — exactly two remote users are typing */
	chatTypingDouble: "{{name}} and {{other}} are typing…",
	/** Typing indicator — three or more remote users are typing */
	chatTypingSeveral: "Several people are typing…",

	// ── Activity toasts (lib/activity) ──────────────────────────────────────
	// The running line of an action and how it ended, in the toast that shows it. `Named` names the one
	// conversation (or participant), `_other` counts them; a partial result counts the ones that succeeded.
	/** Activity toast — marking conversations as read running; one item named ({{name}}) */
	chatsMarkReadRunningNamed: "Marking {{name}} as read",
	/** Activity toast — marking conversations as read running; {{count}} items */
	chatsMarkReadRunning_one: "Marking {{count}} conversation as read",
	/** Activity toast — marking conversations as read running; {{count}} items */
	chatsMarkReadRunning_other: "Marking {{count}} conversations as read",
	/** Activity toast — marking conversations as read finished; one item named ({{name}}) */
	chatsMarkReadDoneNamed: "Marked {{name}} as read",
	/** Activity toast — marking conversations as read finished; {{count}} items */
	chatsMarkReadDone_one: "Marked {{count}} conversation as read",
	/** Activity toast — marking conversations as read finished; {{count}} items */
	chatsMarkReadDone_other: "Marked {{count}} conversations as read",
	/** Activity toast — marking conversations as read failed for every item; one item named ({{name}}) */
	chatsMarkReadFailedNamed: "Couldn't mark {{name}} as read",
	/** Activity toast — marking conversations as read failed for every item; {{count}} items */
	chatsMarkReadFailed_one: "Couldn't mark {{count}} conversation as read",
	/** Activity toast — marking conversations as read failed for every item; {{count}} items */
	chatsMarkReadFailed_other: "Couldn't mark {{count}} conversations as read",
	/** Activity toast — marking conversations as read partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMarkReadPartial_one: "Marked {{count}} conversation as read, {{failed}} failed",
	/** Activity toast — marking conversations as read partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMarkReadPartial_other: "Marked {{count}} conversations as read, {{failed}} failed",
	/** Activity toast — muting conversations running; one item named ({{name}}) */
	chatsMuteRunningNamed: "Muting {{name}}",
	/** Activity toast — muting conversations running; {{count}} items */
	chatsMuteRunning_one: "Muting {{count}} conversation",
	/** Activity toast — muting conversations running; {{count}} items */
	chatsMuteRunning_other: "Muting {{count}} conversations",
	/** Activity toast — muting conversations finished; one item named ({{name}}) */
	chatsMuteDoneNamed: "Muted {{name}}",
	/** Activity toast — muting conversations finished; {{count}} items */
	chatsMuteDone_one: "Muted {{count}} conversation",
	/** Activity toast — muting conversations finished; {{count}} items */
	chatsMuteDone_other: "Muted {{count}} conversations",
	/** Activity toast — muting conversations failed for every item; one item named ({{name}}) */
	chatsMuteFailedNamed: "Couldn't mute {{name}}",
	/** Activity toast — muting conversations failed for every item; {{count}} items */
	chatsMuteFailed_one: "Couldn't mute {{count}} conversation",
	/** Activity toast — muting conversations failed for every item; {{count}} items */
	chatsMuteFailed_other: "Couldn't mute {{count}} conversations",
	/** Activity toast — muting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMutePartial_one: "Muted {{count}} conversation, {{failed}} failed",
	/** Activity toast — muting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsMutePartial_other: "Muted {{count}} conversations, {{failed}} failed",
	/** Activity toast — unmuting conversations running; one item named ({{name}}) */
	chatsUnmuteRunningNamed: "Unmuting {{name}}",
	/** Activity toast — unmuting conversations running; {{count}} items */
	chatsUnmuteRunning_one: "Unmuting {{count}} conversation",
	/** Activity toast — unmuting conversations running; {{count}} items */
	chatsUnmuteRunning_other: "Unmuting {{count}} conversations",
	/** Activity toast — unmuting conversations finished; one item named ({{name}}) */
	chatsUnmuteDoneNamed: "Unmuted {{name}}",
	/** Activity toast — unmuting conversations finished; {{count}} items */
	chatsUnmuteDone_one: "Unmuted {{count}} conversation",
	/** Activity toast — unmuting conversations finished; {{count}} items */
	chatsUnmuteDone_other: "Unmuted {{count}} conversations",
	/** Activity toast — unmuting conversations failed for every item; one item named ({{name}}) */
	chatsUnmuteFailedNamed: "Couldn't unmute {{name}}",
	/** Activity toast — unmuting conversations failed for every item; {{count}} items */
	chatsUnmuteFailed_one: "Couldn't unmute {{count}} conversation",
	/** Activity toast — unmuting conversations failed for every item; {{count}} items */
	chatsUnmuteFailed_other: "Couldn't unmute {{count}} conversations",
	/** Activity toast — unmuting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsUnmutePartial_one: "Unmuted {{count}} conversation, {{failed}} failed",
	/** Activity toast — unmuting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsUnmutePartial_other: "Unmuted {{count}} conversations, {{failed}} failed",
	/** Activity toast — deleting conversations running; one item named ({{name}}) */
	chatsDeleteRunningNamed: "Deleting {{name}}",
	/** Activity toast — deleting conversations running; {{count}} items */
	chatsDeleteRunning_one: "Deleting {{count}} conversation",
	/** Activity toast — deleting conversations running; {{count}} items */
	chatsDeleteRunning_other: "Deleting {{count}} conversations",
	/** Activity toast — deleting conversations finished; one item named ({{name}}) */
	chatsDeleteDoneNamed: "Deleted {{name}}",
	/** Activity toast — deleting conversations finished; {{count}} items */
	chatsDeleteDone_one: "Deleted {{count}} conversation",
	/** Activity toast — deleting conversations finished; {{count}} items */
	chatsDeleteDone_other: "Deleted {{count}} conversations",
	/** Activity toast — deleting conversations failed for every item; one item named ({{name}}) */
	chatsDeleteFailedNamed: "Couldn't delete {{name}}",
	/** Activity toast — deleting conversations failed for every item; {{count}} items */
	chatsDeleteFailed_one: "Couldn't delete {{count}} conversation",
	/** Activity toast — deleting conversations failed for every item; {{count}} items */
	chatsDeleteFailed_other: "Couldn't delete {{count}} conversations",
	/** Activity toast — deleting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsDeletePartial_one: "Deleted {{count}} conversation, {{failed}} failed",
	/** Activity toast — deleting conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsDeletePartial_other: "Deleted {{count}} conversations, {{failed}} failed",
	/** Activity toast — leaving conversations running; one item named ({{name}}) */
	chatsLeaveRunningNamed: "Leaving {{name}}",
	/** Activity toast — leaving conversations running; {{count}} items */
	chatsLeaveRunning_one: "Leaving {{count}} conversation",
	/** Activity toast — leaving conversations running; {{count}} items */
	chatsLeaveRunning_other: "Leaving {{count}} conversations",
	/** Activity toast — leaving conversations finished; one item named ({{name}}) */
	chatsLeaveDoneNamed: "Left {{name}}",
	/** Activity toast — leaving conversations finished; {{count}} items */
	chatsLeaveDone_one: "Left {{count}} conversation",
	/** Activity toast — leaving conversations finished; {{count}} items */
	chatsLeaveDone_other: "Left {{count}} conversations",
	/** Activity toast — leaving conversations failed for every item; one item named ({{name}}) */
	chatsLeaveFailedNamed: "Couldn't leave {{name}}",
	/** Activity toast — leaving conversations failed for every item; {{count}} items */
	chatsLeaveFailed_one: "Couldn't leave {{count}} conversation",
	/** Activity toast — leaving conversations failed for every item; {{count}} items */
	chatsLeaveFailed_other: "Couldn't leave {{count}} conversations",
	/** Activity toast — leaving conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsLeavePartial_one: "Left {{count}} conversation, {{failed}} failed",
	/** Activity toast — leaving conversations partly failed; {{count}} succeeded, {{failed}} failed */
	chatsLeavePartial_other: "Left {{count}} conversations, {{failed}} failed"
} as const
