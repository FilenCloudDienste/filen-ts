import { type Chat } from "@/types"
import useChatMessagesQuery from "@/features/chats/queries/useChatMessages.query"
import { useStringifiedClient } from "@/lib/auth"
import { countUnreadMessages } from "@/features/chats/chatSelectors"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"

export function useChatUnreadCount(chat: Chat): number {
	const stringifiedClient = useStringifiedClient()
	const blocked = useBlockedUsers()
	const chatMessagesQuery = useChatMessagesQuery(
		{
			uuid: chat.uuid
		},
		{
			enabled: false
		}
	)

	// Read the DATA, not the last fetch's verdict (#103): an offline refetch flips `status` to
	// "error" while keeping the messages, and a stale count beats reporting zero unread.
	//
	// The signed-in user is checked explicitly. "Unread by me" means nothing without one, and that
	// used to be answered only as a side effect of the status gate this replaces.
	if (!stringifiedClient || !chatMessagesQuery.data) {
		return 0
	}

	return countUnreadMessages(chatMessagesQuery.data, chat, stringifiedClient.userId, blocked)
}

export default useChatUnreadCount
