import { confirmedAction } from "@/lib/confirmedAction"
import useAppStore from "@/stores/useApp.store"

// Thin wrapper over the shared `confirmedAction` for confirmed destructive chat actions (delete
// chat / leave chat / delete message). Pass `dismissPathnamePrefix` only for actions that should
// close the chat's detail route on success (delete/leave); message-level deletes omit it.
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
	action: () => Promise<unknown>
	dismissPathnamePrefix?: string
}): () => Promise<void> {
	return confirmedAction({
		promptTitle,
		promptMessage,
		promptOkText,
		promptDestructive,
		action,
		dismiss: dismissPathnamePrefix
			? () => useAppStore.getState().pathname.startsWith(dismissPathnamePrefix)
			: undefined
	})
}
