import { useRef, useState } from "react"
import type { Chat as TChat } from "@filen/sdk-rs"
import { memo, useMemo, useCallback } from "@/lib/memo"
import View from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useChatMessagesQuery from "@/queries/useChatMessages.query"
import VirtualList, { type ListRenderItemInfo, type ListRef } from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller"
import { AnimatedView } from "@/components/ui/animated"
import { interpolate, useAnimatedStyle } from "react-native-reanimated"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import Message from "@/components/chats/chat/message"
import { ActivityIndicator } from "react-native"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import chats from "@/lib/chats"
import alerts from "@/lib/alerts"

export const Messages = memo(({ chat }: { chat: TChat }) => {
	const insets = useSafeAreaInsets()
	const keyboardAnimation = useReanimatedKeyboardAnimation()
	const inputViewLayout = useChatsStore(useShallow(state => state.inputViewLayout))
	const listRef = useRef<ListRef<ChatMessageWithInflightId>>(null)
	const [fetchedMessages, setFetchedMessages] = useState<ChatMessageWithInflightId[]>([])
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false)
	const isFetchingMoreRef = useRef<boolean>(false)
	const hasMoreRef = useRef<boolean>(true)

	const chatMessagesQuery = useChatMessagesQuery(
		{
			uuid: chat.uuid
		},
		{
			enabled: !!chat
		}
	)

	const messages = useMemo(() => {
		if (chatMessagesQuery.status !== "success") {
			return []
		}

		return [...chatMessagesQuery.data, ...fetchedMessages].sort((a, b) => Number(b.sentTimestamp) - Number(a.sentTimestamp))
	}, [chatMessagesQuery.data, chatMessagesQuery.status, fetchedMessages])

	const headerStyle = useAnimatedStyle(() => {
		const standardHeight = insets.bottom + inputViewLayout.height + 16

		return {
			height: interpolate(keyboardAnimation.progress.value, [0, 1], [standardHeight, standardHeight - 16]),
			width: "100%",
			backgroundColor: "transparent"
		}
	}, [insets.bottom, keyboardAnimation, inputViewLayout.height])

	const renderItem = useCallback(
		(info: ListRenderItemInfo<ChatMessageWithInflightId>) => {
			if (!chat) {
				return null
			}

			return (
				<Message
					chat={chat}
					info={info}
					nextMessage={messages[info.index - 1]}
					prevMessage={messages[info.index + 1]}
				/>
			)
		},
		[chat, messages]
	)

	const keyExtractor = useCallback((item: ChatMessageWithInflightId) => {
		return item.inner.uuid
	}, [])

	const fetchMore = useCallback(async () => {
		if (isFetchingMoreRef.current || chatMessagesQuery.status !== "success" || messages.length === 0 || !hasMoreRef.current) {
			return
		}

		const result = await run(async defer => {
			isFetchingMoreRef.current = true

			setIsFetchingMore(true)

			defer(() => {
				isFetchingMoreRef.current = false

				setIsFetchingMore(false)
			})

			const lastMessage = messages[messages.length - 1]

			if (!lastMessage) {
				return []
			}

			const moreMessages = await chats.listBefore({
				chat,
				before: lastMessage.sentTimestamp
			})

			return moreMessages.map(m => ({
				...m,
				inflightId: "" // Placeholder, actual inflightId is only needed for send sync
			})) satisfies ChatMessageWithInflightId[]
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		if (result.data.length === 0) {
			hasMoreRef.current = false
		}

		setFetchedMessages(prev => [...prev, ...result.data])
	}, [chatMessagesQuery.status, chat, messages])

	return (
		<View
			className="bg-transparent flex-1"
			style={{
				transform: [
					{
						scaleY: -1
					}
				]
			}}
		>
			<VirtualList
				ref={listRef}
				className="flex-1"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="android:pb-8"
				keyExtractor={keyExtractor}
				data={messages}
				renderItem={renderItem}
				onEndReachedThreshold={0.5}
				footerComponent={
					isFetchingMore
						? () => {
								return (
									<View className="w-full h-auto items-center justify-center pt-4">
										<ActivityIndicator
											size="small"
											color={textMutedForeground.color}
										/>
									</View>
								)
							}
						: undefined
				}
				onEndReached={() => fetchMore()}
				maintainVisibleContentPosition={{
					disabled: true
				}}
				headerComponent={() => {
					return <AnimatedView style={headerStyle} />
				}}
				emptyComponent={() => {
					return (
						<View
							className="flex-1 items-center justify-center"
							style={{
								transform: [
									{
										scaleY: -1
									}
								]
							}}
						>
							<Text>tbd_no_messages</Text>
						</View>
					)
				}}
			/>
		</View>
	)
})

export default Messages
