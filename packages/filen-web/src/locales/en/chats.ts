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
	chatComposerUnavailable: "Sending isn't available yet"
} as const
