import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import useAppStore from "@/stores/useApp.store"
import { t } from "@/lib/i18n"

// Shared shape for confirmed destructive chat actions (delete chat / leave chat / delete
// message): prompt → guard cancel → runWithLoading(action) → guard failure → optionally pop
// back when sitting on a matching detail route. Mirrors notes' `confirmedNoteAction`. Returns
// the onPress handler. Pass `dismissPathnamePrefix` only for actions that should close the
// chat's detail route on success (delete/leave); message-level deletes omit it.
export function confirmedChatAction({
	promptTitle,
	promptMessage,
	promptOkText,
	promptDestructive = true,
	action,
	dismissPathnamePrefix
}: {
	promptTitle: string
	promptMessage: string
	promptOkText: string
	promptDestructive?: boolean
	// Return value is awaited then discarded (matches the original `await chats.X(...)`).
	action: () => Promise<unknown>
	dismissPathnamePrefix?: string
}): () => Promise<void> {
	return async () => {
		const promptResponse = await run(async () => {
			return await prompts.alert({
				title: promptTitle,
				message: promptMessage,
				cancelText: t("cancel"),
				okText: promptOkText,
				destructive: promptDestructive
			})
		})

		if (!promptResponse.success) {
			console.error(promptResponse.error)
			alerts.error(promptResponse.error)

			return
		}

		if (promptResponse.data.cancelled) {
			return
		}

		const result = await runWithLoading(async () => {
			await action()
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (dismissPathnamePrefix && useAppStore.getState().pathname.startsWith(dismissPathnamePrefix) && router.canGoBack()) {
			router.back()
		}
	}
}
