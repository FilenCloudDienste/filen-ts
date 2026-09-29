import { type BulkOutcome } from "@/lib/actions/bulk"
import { type DriveItem } from "@/features/drive/lib/item"
import { toastBulkSummary } from "@/lib/actions/bulkToast"

export function toastBulkOutcome(outcome: BulkOutcome<DriveItem>): void {
	toastBulkSummary(outcome, { complete: "drive:driveBulkActionComplete", withFailures: "drive:driveBulkActionCompleteWithFailures" })
}
