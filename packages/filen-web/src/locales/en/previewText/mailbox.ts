// The mailbox (.mbox) preview.
export const previewTextMailbox = {
	/** Mailbox preview — the list's count while the file has not been read to its end; {{count}} is the messages found so far */
	previewMailboxAtLeast_one: "≥ {{count}} message",
	previewMailboxAtLeast_other: "≥ {{count}} messages",
	/** Mailbox preview — the list's count once every message has been found */
	previewMailboxCount_one: "{{count}} message",
	previewMailboxCount_other: "{{count}} messages",
	/** Mailbox preview — the list's search field: filters the list to messages whose sender or subject holds the text */
	previewMailboxSearch: "Search senders and subjects",
	/** Mailbox preview — under the search field while it runs; {{count}} matches so far, {{searched}} messages looked at */
	previewMailboxSearching_one: "{{count}} match · searching {{searched}} messages…",
	previewMailboxSearching_other: "{{count}} matches · searching {{searched}} messages…",
	/** Mailbox preview — under the search field once it searched the whole file */
	previewMailboxMatches_one: "{{count}} match",
	previewMailboxMatches_other: "{{count}} matches",
	/** Mailbox preview — under the search field when it was stopped */
	previewMailboxMatchesSoFar_one: "{{count}} match so far (stopped)",
	previewMailboxMatchesSoFar_other: "{{count}} matches so far (stopped)",
	/** Mailbox preview — under the search field when it stopped at its limit */
	previewMailboxMatchesCapped: "The first {{count}} matches (the search stops there)",
	/** Mailbox preview — reads the whole file to count its messages */
	previewMailboxCountAll: "Count all",
	/** Mailbox preview — stops counting */
	previewMailboxStop: "Stop",
	/** Mailbox preview — the message list's accessible name */
	previewMailboxList: "Messages",
	/** Mailbox preview — a message row's accessible name while its sender and subject are still being read; {{index}} is its place in the list */
	previewMailboxRowLoading: "Message {{index}}, loading",
	/** Mailbox preview — a row's sender or subject when the message has none */
	previewMailboxNoSender: "(no sender)",
	previewMailboxNoSubject: "(no subject)",
	/** Mailbox preview — the message pane before a message is chosen */
	previewMailboxChoose: "Choose a message to read it.",
	/** Mailbox preview — on a narrow screen, back from a message to the list */
	previewMailboxBack: "Back to the messages",
	/** Mailbox preview — a message past the size the preview reads */
	previewMailboxMessageTooLarge: "This message is too large to show here.",
	/** Mailbox preview — a mailbox whose bytes can be read only whole (an archive's entry its reader cannot seek in) */
	previewMailboxNoRanges: "This mailbox can't be read here: it could only be read whole.",
	/** Mailbox preview — reading a message failed */
	previewMailboxMessageFailed: "The message could not be read."
}
