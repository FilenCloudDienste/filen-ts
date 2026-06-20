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
}

/**
 * Run an async operation across many items, with optional confirmation and
 * a full-screen loading overlay. Returns `true` on full success, `false` on
 * cancel or any failure. On full success the caller's `clearSelection` is
 * called; on cancel or failure the selection is left intact so the user can
 * retry without re-selecting.
 *
 * Failure handling is all-or-nothing (Promise.all is fail-fast). The first
 * failed item rejects the whole batch; remaining items are not awaited.
 * This matches existing Notes/Drive bulk behavior and is the user's chosen
 * policy — partial-failure UX ("X of Y succeeded") is explicitly out of
 * scope.
 */
export async function runBulk<T>({ items, op, clearSelection, confirm }: BulkActionParams<T>): Promise<boolean> {
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
