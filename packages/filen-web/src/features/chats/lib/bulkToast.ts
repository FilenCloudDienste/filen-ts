import { toast } from "sonner"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { type BulkOutcome } from "@/features/drive/lib/bulk"

// Presentation layer for lib/bulk.ts's outcome — mirrors features/notes/lib/bulkToast.ts's
// toastNotesBulkOutcome exactly (own small module, own namespaced i18n keys, same rationale as
// features/contacts/lib/bulkToast.ts for not generalizing across features).
export function toastChatsBulkOutcome(outcome: BulkOutcome<Chat>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("chats:chatsBulkActionComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(i18n.t("chats:chatsBulkActionCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length }))
}

// Separate wording from toastChatsBulkOutcome above (conversations vs. participants) — the
// chatParticipantsDialog's own bulk-remove outcome, same shape reused for the same reason.
export function toastChatParticipantsBulkRemoveOutcome(outcome: BulkOutcome<ChatParticipant>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("chats:chatParticipantsBulkRemoveComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(
		i18n.t("chats:chatParticipantsBulkRemoveCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length })
	)
}
