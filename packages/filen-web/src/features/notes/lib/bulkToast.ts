import { toast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { toastBulkSummary } from "@/lib/actions/bulkToast"
import { type ExportAllOutcome } from "@/features/notes/lib/export"

export function toastNotesBulkOutcome(outcome: BulkOutcome<Note>): void {
	toastBulkSummary(outcome, { complete: "notes:notesBulkActionComplete", withFailures: "notes:notesBulkActionCompleteWithFailures" })
}

export function toastNotesExportOutcome(outcome: ExportAllOutcome): void {
	if (outcome.status === "error") {
		toast.error(errorLabel(outcome.dto))

		return
	}

	if (outcome.skipped > 0) {
		toast.warning(i18n.t("notes:notesExportSkippedUndecryptable", { count: outcome.skipped }))
	}
}
