import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { type Note } from "@filen/sdk-rs"

// Presentation layer for lib/bulk.ts's outcome — mirrors features/drive/lib/bulkToast.ts's
// toastBulkOutcome exactly (own small module, own namespaced i18n keys, same rationale as
// features/contacts/lib/bulkToast.ts for not generalizing across features).
export function toastNotesBulkOutcome(outcome: BulkOutcome<Note>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("notes:notesBulkActionComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(i18n.t("notes:notesBulkActionCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length }))
}
