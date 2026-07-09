import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { type DriveItem } from "@/features/drive/lib/item"

// Presentation layer for any bulk-action helper's outcome (trashItems/restoreItems/deleteItemsPermanently)
// — every selected item runs independently (see bulk.ts), so a partial failure surfaces alongside the
// successes rather than masking them. A single-item call (the per-row menu's own direct restore) is
// just the N=1 case, no special-casing needed. Uses the global i18n singleton directly rather than a
// passed-in `t`, same as errorLabel.ts/__root.tsx — every call site here is outside a namespace-bound
// hook (an event handler, not a render).
export function toastBulkOutcome(outcome: BulkOutcome<DriveItem>): void {
	if (outcome.succeeded.length === 0 && outcome.failed.length === 0) {
		return
	}

	if (outcome.failed.length === 0) {
		toast.success(i18n.t("drive:driveBulkActionComplete", { count: outcome.succeeded.length }))
		return
	}

	toast.error(i18n.t("drive:driveBulkActionCompleteWithFailures", { count: outcome.succeeded.length, failed: outcome.failed.length }))
}
