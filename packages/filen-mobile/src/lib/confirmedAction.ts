import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { confirmPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import { goBackIfPossible } from "@/lib/router"
import { t } from "@/lib/i18n"
import logger from "@/lib/logger"
import useAppStore from "@/stores/useApp.store"

// Shared shape for confirmed destructive actions across features (delete/leave/trash/remove):
// prompt → guard cancel → runWithLoading(action) → guard failure → optionally pop back on
// success. Pop-back is either a `dismiss` predicate (drive checks the item type) or a
// `dismissPathnamePrefix` matched against the current route (notes/chats). The helper adds the
// can-go-back guard, so neither needs to.
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
	// Whether to pop back on success. The helper skips the pop when there is no history.
	dismiss?: () => boolean
	// Pop back on success when the current pathname starts with this. Takes precedence over `dismiss`.
	dismissPathnamePrefix?: string
}): () => Promise<void> {
	return async () => {
		const confirmed = await confirmPrompt(
			{
				title: promptTitle,
				message: promptMessage,
				cancelText: t("cancel"),
				okText: promptOkText,
				destructive: promptDestructive
			},
			{ tag: "confirmedAction", message: "prompt threw unexpectedly" }
		)

		if (!confirmed) {
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

		if (shouldDismiss) {
			goBackIfPossible()
		}
	}
}
