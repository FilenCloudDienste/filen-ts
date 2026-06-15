// Chats feature vocabulary — chat list, conversation view, message bubbles, input, and participants.
// Shared keys (cancel, close, delete, remove, leave, mute, unmute, mark_as_read, select,
// deselect, select_all, deselect_all, selected_one/other, copy, edit, save, participants,
// cannot_decrypt_toast, open_external_link, open_external_link_message, open_trust,
// cannot_open_link, copied_to_clipboard, no_permissions_enable_manually, everyone, unknown)
// live in common.ts and must NOT be redefined here.
export const chats = {
	// ── Chat list header ────────────────────────────────────────────────────────
	/** Chat list tab / screen title */
	chats: "Chats",
	/** Search bar placeholder in the chat list */
	search_chats: "Search chats",
	/** Header menu button: start a new group or direct-message chat */
	create_chat: "New chat",
	/** Bulk-action menu item: mute every selected chat */
	mute_all: "Mute all",
	/** Bulk-action menu item: unmute every selected chat (shown when all selected are already muted) */
	unmute_all: "Unmute all",
	/** Bulk-action menu item: delete every selected chat that the user owns */
	delete_chats: "Delete chats",
	/** Confirmation dialog title shown before deleting all selected chats */
	delete_all_chats: "Delete all chats",
	/** Confirmation dialog message shown before deleting all selected chats */
	delete_all_chats_confirmation: "Are you sure you want to delete all selected chats? This action cannot be undone.",
	// delete_all (the OK button) lives in common.ts.
	/** Bulk-action menu item: leave every selected chat the user participates in but does not own */
	leave_chats: "Leave chats",
	/** Confirmation dialog title shown before leaving all selected chats */
	leave_all_chats: "Leave all chats",
	/** Confirmation dialog message shown before leaving all selected chats */
	leave_all_chats_confirmation: "Are you sure you want to leave all selected chats?",
	/** Confirmation dialog OK button for leaving all selected chats */
	leave_all: "Leave all",

	// ── Chat list empty states ────────────────────────────────────────────────
	/** Empty-state title shown when the chat list has no chats at all */
	no_chats: "No chats",

	// ── Chat list row — last-message preview ─────────────────────────────────
	/** Placeholder shown in the last-message preview when a chat has no messages yet */
	no_messages_yet: "No messages yet",

	// ── Chat list row — typing indicator ─────────────────────────────────────
	/** Typing indicator shown in a chat row when one or more users are typing. {{names}} is the comma-joined list of display names */
	typing_with_names: "{{names}} typing...",
	/** Typing indicator shown in a chat row when the typing user is not identified (bare dots) */
	typing: "typing...",

	// ── Chat list row / context menu ─────────────────────────────────────────
	/** Chat context-menu item: toggle the muted state (shows current state with a checkmark) */
	muted: "Mute notifications",
	/** Chat context-menu item: rename the chat (owner only) */
	edit_name: "Edit name",
	/** Confirmation dialog title for renaming a chat */
	edit_chat_name: "Edit chat name",
	/** Input prompt message asking the user to type a new name for the chat */
	enter_chat_name: "Enter a new chat name",
	/** Confirmation dialog title shown before deleting a single chat (owner) */
	delete_chat: "Delete chat",
	/** Confirmation dialog message shown before deleting a single chat */
	delete_chat_confirmation: "Are you sure you want to delete this chat? This action cannot be undone.",
	/** Confirmation dialog title shown before leaving a single chat (participant, not owner) */
	leave_chat: "Leave chat",
	/** Confirmation dialog message shown before leaving a single chat */
	leave_chat_confirmation: "Are you sure you want to leave this chat?",

	// ── Conversation view — new-messages banner ──────────────────────────────
	/** Singular: unread-messages banner shown at the top of the conversation.
	 *  {{count}} is the unread count and {{date}} is the formatted date of the last focus */
	new_messages_since_one: "{{count}} new message since {{date}}",
	/** Plural: unread-messages banner shown at the top of the conversation.
	 *  {{count}} is the unread count and {{date}} is the formatted date of the last focus */
	new_messages_since_other: "{{count}} new messages since {{date}}",

	// ── Conversation view — "new" separator pill ─────────────────────────────
	/** Pill label that appears above the first unread message in the conversation */
	new: "New",

	// ── Conversation view — empty state ─────────────────────────────────────
	/** Empty-state title shown in a conversation that has no messages yet */
	no_messages: "No messages",

	// ── Conversation view — connection status bar ────────────────────────────
	/** Status-bar label shown while the WebSocket is fully disconnected */
	disconnected: "Disconnected",
	/** Status-bar label shown while the WebSocket is reconnecting */
	reconnecting: "Reconnecting...",

	// ── Message context menu ─────────────────────────────────────────────────
	/** Message context-menu item: reply to this message */
	reply: "Reply",
	/** Confirmation dialog title shown before deleting a single message */
	delete_message: "Delete message",
	/** Confirmation dialog message shown before deleting a single message */
	delete_message_confirmation: "Are you sure you want to delete this message?",

	// ── Chat input ────────────────────────────────────────────────────────────
	/** TextInput placeholder shown in the chat message input when it is empty */
	type_a_message: "Type a message",
	/** Attachment-picker menu item: choose photos or videos from the device gallery */
	add_photos_or_videos_from_gallery: "Add photos or videos",
	// take_photo_or_video lives in common.ts.
	/** Attachment-picker menu item: attach files from the device file system */
	add_files: "Add files",
	/** Attachment-picker menu item: attach items from the Filen drive */
	add_drive_items: "Add from Filen drive",
	/** Error banner when an outgoing message could not be persisted to device storage (it survives in memory only until sent) */
	chat_message_not_saved_to_device: "Your message could not be saved on this device. Keep the app open until it has been sent.",

	// ── Chat participants screen ─────────────────────────────────────────────
	/** Header title for the chat participants management screen */
	chat_participants: "Chat participants",
	/** Menu item (owner only): add a new participant to the chat */
	add_participant: "Add participant",
	/** Empty-state title shown when the chat has no other participants */
	no_chat_participants: "No participants",
	// remove_participant and remove_selected live in common.ts.
	/** Confirmation dialog message shown before removing a single participant */
	remove_participant_confirmation: "Are you sure you want to remove this participant?",
	/** Confirmation dialog message shown before bulk-removing selected participants */
	remove_selected_participants_confirmation: "Are you sure you want to remove all selected participants?",

	// ── Empty-state subtitles (ListEmpty descriptions) ────────────────────────
	/** Chat list — empty-state subtitle when no chats exist yet */
	no_chats_description: "Start a conversation with one of your contacts.",
	/** Conversation — empty-state subtitle when the chat has no messages yet */
	no_messages_description: "Send a message to start the conversation.",
	/** Chat participants — empty-state subtitle when the chat has no other participants */
	no_chat_participants_description: "Add people to start chatting.",
	// ── Blocked users ─────────────────────────────────────────────────────────
	/** Tombstone shown in place of a message (or chat-list preview) from a blocked user */
	message_hidden_blocked: "Message hidden",
	/** Reveal affordance on a blocked-message tombstone */
	message_hidden_blocked_show: "Show"
} as const
