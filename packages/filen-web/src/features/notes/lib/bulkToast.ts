import { type Note } from "@filen/sdk-rs"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { toastBulkSummary } from "@/lib/actions/bulkToast"

export function toastNotesBulkOutcome(outcome: BulkOutcome<Note>): void {
	toastBulkSummary(outcome, { complete: "notes:notesBulkActionComplete", withFailures: "notes:notesBulkActionCompleteWithFailures" })
}
