import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import type { AppKey } from "@/lib/i18n/appKey"
import { type BulkOutcome } from "@/lib/actions/bulk"

// Narrowed by naming convention: i18n.t cannot type the options for a union of arbitrary keys.
export interface SummaryKeys {
	complete: Extract<AppKey, `${string}:${string}Complete`>
	withFailures: Extract<AppKey, `${string}:${string}CompleteWithFailures`>
}

// One summary toast for independently-run items, so a partial failure surfaces alongside the
// successes. Nothing ran (all cancelled, or an empty selection): nothing to report. `failureId`: the
// toast a partial failure replaces.
export function toastSummary(succeeded: number, failed: number, keys: SummaryKeys, failureId?: string): void {
	if (succeeded === 0 && failed === 0) {
		return
	}

	if (failed === 0) {
		toast.success(i18n.t(keys.complete, { count: succeeded }))
		return
	}

	const text = i18n.t(keys.withFailures, { count: succeeded, failed })

	if (failureId === undefined) {
		toast.error(text)
	} else {
		toast.error(text, { id: failureId })
	}
}

export function toastBulkSummary(outcome: BulkOutcome<unknown>, keys: SummaryKeys): void {
	toastSummary(outcome.succeeded.length, outcome.failed.length, keys)
}
