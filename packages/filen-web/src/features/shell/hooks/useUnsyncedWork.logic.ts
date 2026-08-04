import type { InflightContent } from "@/features/notes/store/useNotesInflight"
import type { InflightChatMessageErrors, InflightChatMessages } from "@/features/chats/store/useChatsInflight"

// What "unsynced" means for the sign-out confirm: content that exists ONLY on this device and dies with
// the wipe. Pure so the predicate is testable without rendering the rail.

// A note whose entry list is empty is a drained note the outbox has not yet pruned — not pending work.
export function hasUnsyncedNotes(inflightContent: InflightContent): boolean {
	return Object.values(inflightContent).some(entries => entries.length > 0)
}

// Queued sends AND failed ones: a send dropped after its retry budget keeps only an error record
// (useChatsInflight), and its text lives nowhere else — the user can still retry it right up until
// sign-out throws it away.
export function hasUnsyncedChatSends(inflightMessages: InflightChatMessages, inflightErrors: InflightChatMessageErrors): boolean {
	return Object.values(inflightMessages).some(group => group.messages.length > 0) || Object.keys(inflightErrors).length > 0
}
