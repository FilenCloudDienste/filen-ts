import { type BulkOutcome } from "@/lib/actions/bulk"
import { toastBulkSummary } from "@/lib/actions/bulkToast"

// Generic over the item type: each contacts bulk action runs over a differently-shaped record.
export function toastContactsBulkOutcome<T>(outcome: BulkOutcome<T>): void {
	toastBulkSummary(outcome, {
		complete: "contacts:contactsBulkActionComplete",
		withFailures: "contacts:contactsBulkActionCompleteWithFailures"
	})
}
