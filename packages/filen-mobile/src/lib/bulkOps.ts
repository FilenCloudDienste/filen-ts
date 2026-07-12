import { run } from "@filen/utils"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import logger from "@/lib/logger"

export type BulkActionConfirm = {
	title: string
	message: string
	okText: string
	cancelText?: string
	destructive?: boolean
}

export type BulkActionParams<T> = {
	items: T[]
	op: (item: T) => Promise<unknown>
	clearSelection: () => void
	confirm?: BulkActionConfirm
	// When true, skip the blocking full-screen loading overlay and don't wait for the batch to
	// finish: clear the selection immediately and fire each op independently, surfacing per-item
	// failures via alerts. For ops that kick off long-running transfers (make-available-offline
	// downloads full files) a blocking overlay would freeze the whole app until every transfer
	// completed (#60) and hide the floating transfer bar, which is the real progress UI. In this
	// mode runBulk returns `true` as soon as the ops are dispatched — the boolean no longer
	// reflects op success.
	background?: boolean
}

/**
 * Run an async operation across many items, with optional confirmation.
 *
 * Foreground (default) mode shows a full-screen loading overlay and awaits the whole batch.
 * Returns `true` on full success, `false` on cancel or any failure. On full success the caller's
 * `clearSelection` is called; on cancel or failure the selection is left intact so the user can
 * retry without re-selecting. Failure handling is all-or-nothing (Promise.all is fail-fast): the
 * first failed item rejects the whole batch; remaining items are not awaited. This matches
 * existing Notes/Drive bulk behavior and is the user's chosen policy — partial-failure UX
 * ("X of Y succeeded") is explicitly out of scope.
 *
 * `background: true` mode is for ops that kick off long-running background work (offline stores
 * download full files via the transfers system). It skips the overlay, clears the selection up
 * front, and fires each op independently — surfacing per-item failures via alerts — so the app
 * stays interactive and progress shows in the floating transfer bar instead of a blocking
 * spinner (#60).
 */
export async function runBulk<T>({ items, op, clearSelection, confirm, background }: BulkActionParams<T>): Promise<boolean> {
	if (items.length === 0) {
		return false
	}

	if (confirm) {
		const promptResult = await run(async () => {
			return await prompts.alert({
				title: confirm.title,
				message: confirm.message,
				okText: confirm.okText,
				cancelText: confirm.cancelText,
				destructive: confirm.destructive
			})
		})

		if (!promptResult.success) {
			logger.warn("bulkOps", "confirm prompt threw unexpectedly", { error: promptResult.error })
			alerts.error(promptResult.error)

			return false
		}

		if (promptResult.data.cancelled) {
			return false
		}
	}

	if (background) {
		// Non-blocking dispatch: clear the selection up front (it can't be deferred to a success
		// we no longer wait for) and fire each op independently, surfacing per-item failures via
		// alerts. Mirrors the per-item Make-offline action, which blocks nothing and clears
		// nothing but the menu — progress then shows in the floating transfer bar.
		clearSelection()

		for (const item of items) {
			void run(async () => op(item))
				.then(itemResult => {
					if (!itemResult.success) {
						logger.error("bulkOps", "background bulk operation item failed", { error: itemResult.error })
						alerts.error(itemResult.error)
					}
				})
				.catch(error => {
					// run() never rejects; guard anyway so a handler bug can't leak an unhandled rejection.
					logger.error("bulkOps", "background bulk operation handler threw", { error })
				})
		}

		return true
	}

	const result = await runWithLoading(async () => {
		await Promise.all(items.map(item => op(item)))
	})

	if (!result.success) {
		logger.error("bulkOps", "bulk operation failed", { error: result.error })
		alerts.error(result.error)

		return false
	}

	clearSelection()

	return true
}

export default runBulk
