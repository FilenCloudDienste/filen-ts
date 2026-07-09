import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type BulkOutcome } from "@/features/drive/lib/bulk"

// Presentation layer for runContactsBulk's outcome (bulk-accept/deny/cancel/remove/block/unblock) —
// mirrors lib/drive/bulk-toast.ts's toastBulkOutcome, kept as its own small module rather than
// generalizing that one: the two emit differently-namespaced i18n keys and share no caller. Generic
// over the bulk item type since each contacts bulk action runs over a differently-shaped record
// (ContactRequestIn/Out, Contact, BlockedContact) and this only ever reads succeeded/failed counts.
export function toastContactsBulkOutcome<T>(outcome: BulkOutcome<T>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("contacts:contactsBulkActionComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(
		i18n.t("contacts:contactsBulkActionCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length })
	)
}
