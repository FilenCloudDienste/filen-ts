import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { toastBulkSummary } from "@/lib/actions/bulkToast"

export function toastChatsBulkOutcome(outcome: BulkOutcome<Chat>): void {
	toastBulkSummary(outcome, { complete: "chats:chatsBulkActionComplete", withFailures: "chats:chatsBulkActionCompleteWithFailures" })
}

export function toastChatParticipantsBulkRemoveOutcome(outcome: BulkOutcome<ChatParticipant>): void {
	toastBulkSummary(outcome, {
		complete: "chats:chatParticipantsBulkRemoveComplete",
		withFailures: "chats:chatParticipantsBulkRemoveCompleteWithFailures"
	})
}
