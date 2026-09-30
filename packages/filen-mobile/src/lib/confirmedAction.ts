import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/shared"
import alerts from "@/lib/alerts"
import { router } from "@/lib/router"
import { t } from "@/lib/i18n"
import logger from "@/lib/logger"
import useAppStore from "@/stores/useApp.store"

// Shared shape for confirmed destructive actions across features (delete/leave/trash/remove):
// prompt → guard cancel → runWithLoading(action) → guard failure → optionally pop back on
// success. Pop-back is either a `dismiss` predicate (drive checks the item type) or a
// `dismissPathnamePrefix` matched against the current route (notes/chats). The helper adds the
// `router.canGoBack()` guard, so neither needs to.
export function confirmedAction({
	promptTitle,
	promptMessage,
	promptOkText,
	promptDestructive = true,
	action,
	dismiss,
	dismissPathnamePrefix
}: {
	promptTitle: string
	promptMessage: string
	promptOkText: string
	// The plain `trash` action is the one site that omits destructive styling on the alert
	// itself — default true preserves the destructive look everywhere else.
	promptDestructive?: boolean
	// Return value is awaited then discarded (matches the original `await feature.X(...)`).
	action: () => Promise<unknown>
	// Whether to pop back on success. `router.canGoBack()` is checked by the helper.
	dismiss?: () => boolean
	// Pop back on success when the current pathname starts with this. Takes precedence over `dismiss`.
	dismissPathnamePrefix?: string
}): () => Promise<void> {
	return async () => {
		const promptResult = await run(async () => {
			return await prompts.alert({
				title: promptTitle,
				message: promptMessage,
				cancelText: t("cancel"),
				okText: promptOkText,
				destructive: promptDestructive
			})
		})

		if (!promptResult.success) {
			logger.warn("confirmedAction", "prompt threw unexpectedly", { error: promptResult.error })
			alerts.error(promptResult.error)

			return
		}

		if (promptResult.data.cancelled) {
			return
		}

		const result = await runWithLoading(async () => {
			await action()
		})

		if (!result.success) {
			logger.error("confirmedAction", "action failed", { error: result.error })
			alerts.error(result.error)

			return
		}

		const shouldDismiss = dismissPathnamePrefix ? useAppStore.getState().pathname.startsWith(dismissPathnamePrefix) : dismiss?.()

		if (shouldDismiss && router.canGoBack()) {
			router.back()
		}
	}
}
