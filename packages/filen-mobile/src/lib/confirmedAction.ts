import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { t } from "@/lib/i18n"
import logger from "@/lib/logger"

// Shared shape for confirmed destructive actions across features (delete/leave/trash/remove):
// prompt → guard cancel → runWithLoading(action) → guard failure → optionally pop back on
// success. Each feature wraps this with its own `dismiss` predicate (drive checks item.type,
// notes/chats check the current pathname). The helper adds the `router.canGoBack()` guard, so
// `dismiss` only needs to express the feature-specific condition.
export function confirmedAction({
	promptTitle,
	promptMessage,
	promptOkText,
	promptDestructive = true,
	action,
	dismiss
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
			logger.warn("confirmedAction", "prompt threw unexpectedly", { error: String(promptResult.error) })
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
			logger.error("confirmedAction", "action failed", { error: String(result.error) })
			alerts.error(result.error)

			return
		}

		if (dismiss?.() && router.canGoBack()) {
			router.back()
		}
	}
}
