import { type Chat } from "@/types"
import useChatMessagesQuery from "@/features/chats/queries/useChatMessages.query"
import { useStringifiedClient } from "@/lib/auth"
import { isMessageUnread } from "@/features/chats/chatSelectors"
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

	const unreadCount =
		chatMessagesQuery.status === "success"
			? chatMessagesQuery.data.filter(message => isMessageUnread(message, chat, stringifiedClient?.userId, blocked)).length
			: 0

	return unreadCount
}

export default useChatUnreadCount
