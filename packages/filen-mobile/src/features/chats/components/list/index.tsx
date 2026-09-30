import useChatsQuery from "@/features/chats/queries/useChats.query"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty, { NoResultsEmpty } from "@/components/ui/listEmpty"
import { type Chat as TChat } from "@/types"
import { compareChats, run, contactDisplayName } from "@filen/shared"
import alerts from "@/lib/alerts"
import Chat from "@/features/chats/components/list/chat"
import { useStringifiedClient } from "@/lib/auth"
import { chatDisplayName } from "@/lib/decryption"
import { useTranslation } from "react-i18next"
import Button from "@/components/ui/button"
import { createChatFlow } from "@/features/chats/chatsActions"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { visibleChats } from "@/features/chats/chatSelectors"
import logger from "@/lib/logger"
import { TAB_LIST_CONTENT_CLASS } from "@/constants"

const List = ({ searchQuery }: { searchQuery: string }) => {
	const { t } = useTranslation()
	const chatsQuery = useChatsQuery()
	const stringigiedClient = useStringifiedClient()
	const blocked = useBlockedUsers()

	const chats = (() => {
		// Read the DATA, not the last fetch's verdict: an offline refetch fails and flips `status` to
	// "error" while keeping it (#103).
		if (!chatsQuery.data) {
			return []
		}

		let chats = visibleChats(chatsQuery.data, stringigiedClient?.userId, blocked).sort(compareChats)

		if (searchQuery && searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.toLowerCase().trim()
			const currentUserId = stringigiedClient?.userId

			chats = chats.filter(chat => {
				if (
					currentUserId !== undefined &&
					chatDisplayName(chat, currentUserId, t("just_you")).toLowerCase().includes(searchQueryNormalized)
				) {
					return true
				}

				if (
					chat.lastMessage &&
					chat.lastMessage.inner.message &&
					chat.lastMessage.inner.message.toLowerCase().includes(searchQueryNormalized)
				) {
					return true
				}

				for (const participant of chat.participants) {
					if (participant.email.toLowerCase().trim().includes(searchQueryNormalized)) {
						return true
					}

					if (contactDisplayName(participant).toLowerCase().trim().includes(searchQueryNormalized)) {
						return true
					}
				}

				return false
			})
		}

		return chats
	})()

	const onRefresh = async () => {
		const result = await run(async () => {
			await chatsQuery.refetch()
		})

		if (!result.success) {
			logger.error("chats", "chat list refresh failed", { error: result.error })
			alerts.error(result.error)
		}
	}

	const keyExtractor = (chat: TChat) => {
		return chat.uuid
	}

	const renderItem = (info: ListRenderItemInfo<TChat>) => {
		return <Chat info={info} />
	}

	const emptyComponent = () =>
		searchQuery && searchQuery.length > 0 ? (
			<NoResultsEmpty />
		) : (
			<ListEmpty
				icon="chatbubbles-outline"
				title={t("no_chats")}
				description={t("no_chats_description")}
				action={
					<Button
						onPress={() => void createChatFlow()}
						requiresOnline
					>
						{t("create_chat")}
					</Button>
				}
			/>
		)

	return (
		<VirtualList
			className="flex-1"
			contentContainerClassName={TAB_LIST_CONTENT_CLASS}
			loading={chatsQuery.status === "pending"}
			keyExtractor={keyExtractor}
			data={chats}
			renderItem={renderItem}
			requiresOnline={true}
			onRefresh={onRefresh}
			emptyComponent={emptyComponent}
		/>
	)
}

export default List
