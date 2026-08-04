import useNotesInflightStore from "@/features/notes/store/useNotesInflight"
import useChatsInflightStore from "@/features/chats/store/useChatsInflight"
import { hasUnsyncedNotes, hasUnsyncedChatSends } from "@/features/shell/hooks/useUnsyncedWork.logic"

// True while either durable outbox still holds something the server has never seen. Sign-out cancels
// both loops and wipes their storage (performLogout), so the confirm reads this to warn instead of
// promising the content syncs back. Two boolean-collapsed selectors, so typing in a note or a composer
// re-renders the subscriber only on the has/has-not edge.
export function useHasUnsyncedWork(): boolean {
	const notes = useNotesInflightStore(state => hasUnsyncedNotes(state.inflightContent))
	const chats = useChatsInflightStore(state => hasUnsyncedChatSends(state.inflightMessages, state.inflightErrors))

	return notes || chats
}
