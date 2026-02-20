import { Fragment, useEffect } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { useLocalSearchParams, Redirect, useRouter } from "expo-router"
import type { Chat as TChat } from "@filen/sdk-rs"
import { Platform, ActivityIndicator } from "react-native"
import { memo, useMemo, useCallback } from "@/lib/memo"
import useChatsQuery from "@/queries/useChats.query"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"
import { cn, fastLocaleCompare, runEffect } from "@filen/utils"
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller"
import { AnimatedView } from "@/components/ui/animated"
import { interpolate, useAnimatedStyle } from "react-native-reanimated"
import { contactDisplayName } from "@/lib/utils"
import { useStringifiedClient } from "@/lib/auth"
import Avatar from "@/components/ui/avatar"
import { useShallow } from "zustand/shallow"
import Input from "@/components/chats/chat/input"
import events from "@/lib/events"
import useSocketStore from "@/stores/useSocket.store"
import Messages from "@/components/chats/chat/messages"
import { createMenuButtons } from "@/components/chats/list/chat/menu"
import { PressableOpacity } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import chats from "@/lib/chats"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { simpleDateNoTime } from "@/lib/time"
import useChatUnreadCount from "@/hooks/useChatUnreadCount"
import useChatsStore from "@/stores/useChats.store"

const HeaderTitle = memo(({ chat }: { chat: TChat }) => {
	const stringigiedClient = useStringifiedClient()

	const title = useMemo(() => {
		if (chat.name && chat.name.length > 0) {
			return chat.name
		}

		if (chat.participants.length === 2) {
			const otherParticipant = chat.participants.find(p => p.userId !== stringigiedClient?.userId)

			if (otherParticipant) {
				return contactDisplayName(otherParticipant)
			}
		}

		return chat.participants
			.filter(p => p.userId !== stringigiedClient?.userId)
			.sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
			.map(p => contactDisplayName(p))
			.join(", ")
	}, [chat.name, chat.participants, stringigiedClient?.userId])

	const participantsWithAvatars = useMemo(() => {
		return chat.participants
			.filter(p => p.userId !== stringigiedClient?.userId && p.avatar && p.avatar.startsWith("http"))
			.sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
			.map(p => p.avatar)
			.slice(0, 5)
	}, [chat.participants, stringigiedClient?.userId])

	return (
		<View
			className={cn(
				"items-center flex-col justify-center bg-transparent w-full",
				Platform.select({
					ios: "pr-9",
					default: "pr-3"
				})
			)}
		>
			<View className="flex-row items-center -mt-1 bg-transparent">
				{participantsWithAvatars.length === 0 ? (
					<Avatar
						className="shrink-0 z-10"
						size={36}
						immediateFallback={true}
					/>
				) : participantsWithAvatars.length === 1 ? (
					<Avatar
						className="shrink-0 z-10"
						size={36}
						source={{
							uri: participantsWithAvatars.at(0)
						}}
					/>
				) : (
					<View className="flex-row items-center bg-transparent">
						{participantsWithAvatars.map((avatar, index) => {
							return (
								<Avatar
									key={avatar}
									className={cn("shrink-0", index > 0 && "-ml-12")}
									size={32}
									style={{
										zIndex: 100 - index
									}}
									source={{
										uri: avatar
									}}
								/>
							)
						})}
					</View>
				)}
			</View>
			<CrossGlassContainerView
				className="bg-background-secondary border border-border py-0.5 px-1.5 rounded-full -mt-2"
				disableBlur={Platform.OS === "android"}
			>
				<Text
					className="text-foreground"
					numberOfLines={1}
					ellipsizeMode="tail"
				>
					{title}
				</Text>
			</CrossGlassContainerView>
		</View>
	)
})

const Header = memo(({ chat }: { chat: TChat }) => {
	const stringigiedClient = useStringifiedClient()
	const textForeground = useResolveClassNames("text-foreground")
	const isSelected = useChatsStore(useShallow(state => state.selectedChats.some(n => n.uuid === chat.uuid)))
	const unreadCount = useChatUnreadCount(chat)

	const headerRightItems = useMemo(() => {
		if (!stringigiedClient) {
			return []
		}

		return [
			{
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: createMenuButtons({
						chat,
						userId: stringigiedClient.userId,
						origin: "chat",
						isSelected,
						unreadCount
					})
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			}
		] satisfies HeaderItem[]
	}, [stringigiedClient, chat, isSelected, unreadCount, textForeground.color])

	return (
		<StackHeader
			title={<HeaderTitle chat={chat} />}
			backVisible={true}
			transparent={false}
			shadowVisible={true}
			rightItems={headerRightItems}
		/>
	)
})

const Unread = memo(({ chat }: { chat: TChat }) => {
	const unreadCount = useChatUnreadCount(chat)

	const markAsRead = useCallback(async () => {
		if (!chat) {
			return
		}

		const result = await runWithLoading(async () => {
			return await Promise.all([
				chats.updateLastFocusTimesNow({
					chats: [chat]
				}),
				chats.markRead({
					chat
				})
			])
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}
	}, [chat])

	if (unreadCount === 0) {
		return null
	}

	return (
		<PressableOpacity
			className="absolute top-0 left-0 right-0 items-center z-20 bg-blue-500 py-2 flex-row justify-between gap-4 px-4 rounded-b-lg"
			onPress={markAsRead}
		>
			<Text
				className="text-white"
				numberOfLines={1}
				ellipsizeMode="middle"
			>
				{unreadCount} tbd_new_messages_since {simpleDateNoTime(Number(chat.lastFocus))}
			</Text>
			<Ionicons
				className="shrink-0"
				name="checkmark"
				size={20}
				color="white"
			/>
		</PressableOpacity>
	)
})

export const Chat = memo(() => {
	const { uuid } = useLocalSearchParams<{
		uuid: string
	}>()
	const keyboardAnimation = useReanimatedKeyboardAnimation()
	const router = useRouter()
	const socketState = useSocketStore(useShallow(state => state.state))
	const textForeground = useResolveClassNames("text-foreground")

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const chat = useMemo(() => {
		return chatsQuery.data?.find(c => c.uuid === uuid) as TChat
	}, [chatsQuery.data, uuid])

	const containerStyle = useAnimatedStyle(() => {
		return {
			paddingBottom: interpolate(
				keyboardAnimation.progress.value,
				[0, 1],
				[8, -keyboardAnimation.height.value + (Platform.OS === "ios" ? -10 : 0) + 8]
			)
		}
	}, [keyboardAnimation])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const chatConversationDeletedSubscription = events.subscribe("chatConversationDeleted", info => {
				if (info.uuid !== uuid || !router.canGoBack()) {
					return
				}

				router.replace("/tabs/chats")
			})

			defer(() => {
				chatConversationDeletedSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [uuid, router])

	if (!(chat as TChat | undefined)) {
		return <Redirect href="/tabs/chats" />
	}

	return (
		<Fragment>
			<Header chat={chat} />
			<SafeAreaView edges={["left", "right"]}>
				<AnimatedView
					className="flex-1 bg-transparent"
					style={containerStyle}
				>
					{socketState !== "connected" && (
						<View className="absolute top-0 left-0 right-0 items-center z-10 bg-red-500 py-1 flex-row justify-center gap-2">
							<ActivityIndicator
								size="small"
								color={textForeground.color}
							/>
							<Text
								className="text-foreground"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{socketState === "disconnected" ? "tbd_disconnected" : "tbd_reconnecting"}
							</Text>
						</View>
					)}
					<Unread chat={chat} />
					<Messages chat={chat} />
				</AnimatedView>
			</SafeAreaView>
			<Input chat={chat} />
		</Fragment>
	)
})

export default Chat
