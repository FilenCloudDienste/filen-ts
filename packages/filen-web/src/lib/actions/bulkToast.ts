import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import type { AppKey } from "@/lib/i18n/appKey"
import { type BulkOutcome } from "@/lib/actions/bulk"

// Narrowed by naming convention: i18n.t cannot type the options for a union of arbitrary keys.
export interface SummaryKeys {
	complete: Extract<AppKey, `${string}:${string}Complete`>
	withFailures: Extract<AppKey, `${string}:${string}CompleteWithFailures`>
}

export interface SummaryOptions {
	// The toast a partial failure replaces.
	failureId?: string
	// Runs the failed items again ("Retry failed"); offered only alongside a failure.
	retry?: (() => void) | undefined
}

// One summary toast for independently-run items, so a partial failure surfaces alongside the
// successes. Nothing ran (all cancelled, or an empty selection): nothing to report.
export function toastSummary(succeeded: number, failed: number, keys: SummaryKeys, options?: SummaryOptions): void {
	if (succeeded === 0 && failed === 0) {
		return
	}

	if (failed === 0) {
		toast.success(i18n.t(keys.complete, { count: succeeded }))
		return
	}

	const text = i18n.t(keys.withFailures, { count: succeeded, failed })
	const retry = options?.retry
	const failureId = options?.failureId

	if (failureId === undefined && retry === undefined) {
		toast.error(text)

		return
	}

	toast.error(text, {
		...(failureId === undefined ? {} : { id: failureId }),
		...(retry === undefined ? {} : { action: { label: i18n.t("transfers:transfersRetryFailed"), onClick: retry } })
	})
}

export function toastBulkSummary(outcome: BulkOutcome<unknown>, keys: SummaryKeys): void {
	toastSummary(outcome.succeeded.length, outcome.failed.length, keys)
}
