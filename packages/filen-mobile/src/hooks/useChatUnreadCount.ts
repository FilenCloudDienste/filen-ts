import type { Chat } from "@filen/sdk-rs"
import useChatMessagesQuery from "@/queries/useChatMessages.query"
import { useStringifiedClient } from "@/lib/auth"

export function useChatUnreadCount(chat: Chat): number {
	const stringifiedClient = useStringifiedClient()
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
			? chatMessagesQuery.data.filter(
					message =>
						chat.lastFocus &&
						chat.lastMessage &&
						!chat.muted &&
						message.sentTimestamp > chat.lastFocus &&
						message.inner.senderId !== stringifiedClient?.userId
				).length
			: 0

	return unreadCount
}

export default useChatUnreadCount
