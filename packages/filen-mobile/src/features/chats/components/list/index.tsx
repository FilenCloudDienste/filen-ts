import useChatsQuery from "@/features/chats/queries/useChats.query"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { type Chat as TChat } from "@/types"
import { parseNumbersFromString, run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Chat from "@/features/chats/components/list/chat"
import { useStringifiedClient } from "@/lib/auth"
import { contactDisplayName } from "@/lib/utils"
import { chatDisplayName } from "@/lib/decryption"
import { Platform } from "react-native"
import { onlineManager } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import Button from "@/components/ui/button"
import { createChatFlow } from "@/features/chats/chatsActions"
import useIsOnline from "@/hooks/useIsOnline"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { isOneOnOneWithBlocked } from "@/features/chats/chatSelectors"
import logger from "@/lib/logger"

const List = ({ searchQuery }: { searchQuery: string }) => {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const chatsQuery = useChatsQuery()
	const stringigiedClient = useStringifiedClient()
	const blocked = useBlockedUsers()

	const chats = (() => {
		if (chatsQuery.status !== "success") {
			return []
		}

		let chats = chatsQuery.data
			.filter(chat => chat.ownerId === stringigiedClient?.userId || chat.lastMessage)
			.filter(chat => !isOneOnOneWithBlocked(chat, stringigiedClient?.userId, blocked))
			.sort((a, b) => {
				const aLastMessageTimestamp = a.lastMessage ? Number(a.lastMessage.sentTimestamp) : 0
				const bLastMessageTimestamp = b.lastMessage ? Number(b.lastMessage.sentTimestamp) : 0

				if (aLastMessageTimestamp === bLastMessageTimestamp) {
					return parseNumbersFromString(b.uuid) - parseNumbersFromString(a.uuid)
				}

				return bLastMessageTimestamp - aLastMessageTimestamp
			})

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
		if (!onlineManager.isOnline()) {
			return
		}

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
			<ListEmpty
				icon="search-outline"
				title={t("no_results")}
				description={t("no_results_description")}
			/>
		) : (
			<ListEmpty
				icon="chatbubbles-outline"
				title={t("no_chats")}
				description={t("no_chats_description")}
				action={
					<Button
						onPress={() => void createChatFlow()}
						disabled={!isOnline}
					>
						{t("create_chat")}
					</Button>
				}
			/>
		)

	return (
		<VirtualList
			className="flex-1"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
			loading={chatsQuery.status === "pending"}
			keyExtractor={keyExtractor}
			data={chats}
			renderItem={renderItem}
			onRefresh={onRefresh}
			emptyComponent={emptyComponent}
		/>
	)
}

export default List
