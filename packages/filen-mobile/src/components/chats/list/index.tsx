import Text from "@/components/ui/text"
import useChatsQuery from "@/queries/useChats.query"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import type { Chat as TChat } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import { parseNumbersFromString, run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import Chat from "@/components/chats/list/chat"
import { useStringifiedClient } from "@/lib/auth"
import { contactDisplayName } from "@/lib/utils"
import { useState, memo } from "react"
import { Platform } from "react-native"

const List = memo(() => {
	const chatsQuery = useChatsQuery()
	const stringigiedClient = useStringifiedClient()
	const [searchQuery, setSearchQuery] = useState<string>("")

	const chats = (() => {
		if (chatsQuery.status !== "success") {
			return []
		}

		let chats = chatsQuery.data
			.filter(chat => chat.ownerId === stringigiedClient?.userId || chat.lastMessage)
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

			chats = chats.filter(chat => {
				if (chat.name && chat.name.toLowerCase().includes(searchQueryNormalized)) {
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
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	const keyExtractor = (chat: TChat) => {
		return chat.uuid
	}

	const renderItem = (info: ListRenderItemInfo<TChat>) => {
		return <Chat info={info} />
	}

	const emptyComponent = () => {
		return (
			<View className="flex-1 items-center justify-center">
				<Text>{searchQuery && searchQuery.length > 0 ? "tbd_no_chats_search" : "tbd_no_chats"}</Text>
			</View>
		)
	}

	const searchBarProps = {
		onChangeText: setSearchQuery,
		placeholder: "tbd_search_chats"
	}

	return (
		<VirtualList
			className="flex-1"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
			loading={chatsQuery.status !== "success"}
			keyExtractor={keyExtractor}
			data={chats}
			renderItem={renderItem}
			onRefresh={onRefresh}
			emptyComponent={emptyComponent}
			searchBar={searchBarProps}
		/>
	)
})

export default List
