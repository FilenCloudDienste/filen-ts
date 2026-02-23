import Text from "@/components/ui/text"
import { memo, useMemo, useCallback } from "@/lib/memo"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { Chat as TChat } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import Avatar from "@/components/ui/avatar"
import { PressableScale } from "@/components/ui/pressables"
import Menu from "@/components/chats/list/chat/menu"
import { contactDisplayName } from "@/lib/utils"
import { useRouter } from "expo-router"
import { useStringifiedClient } from "@/lib/auth"
import { fastLocaleCompare, cn } from "@filen/utils"
import useChatUnreadCount from "@/hooks/useChatUnreadCount"
import useChatsStore from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { Checkbox } from "@/components/ui/checkbox"

export const Chat = memo(({ info }: { info: ListRenderItemInfo<TChat> }) => {
	const router = useRouter()
	const stringifiedClient = useStringifiedClient()
	const unreadCount = useChatUnreadCount(info.item)
	const typing = useChatsStore(useShallow(state => state.typing[info.item.uuid] ?? []))
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const isSelected = useChatsStore(useShallow(state => state.selectedChats.some(n => n.uuid === info.item.uuid)))
	const areChatsSelected = useChatsStore(useShallow(state => state.selectedChats.length > 0))

	const typingUsers = useMemo(() => {
		return typing
			.map(t => t.senderId)
			.map(senderId => info.item.participants.find(p => p.userId === senderId))
			.filter(Boolean)
			.map(participant => contactDisplayName(participant!))
	}, [typing, info.item.participants])

	const participantsWithoutSelf = useMemo(() => {
		return info.item.participants.filter(p => p.userId !== stringifiedClient?.userId)
	}, [info.item.participants, stringifiedClient?.userId])

	const title = useMemo(() => {
		if (info.item.name && info.item.name.length > 0) {
			return info.item.name
		}

		if (participantsWithoutSelf.length === 1) {
			const otherParticipant = participantsWithoutSelf[0]

			if (otherParticipant) {
				return contactDisplayName(otherParticipant)
			}
		}

		return participantsWithoutSelf
			.sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
			.map(p => contactDisplayName(p))
			.join(", ")
	}, [info.item.name, participantsWithoutSelf])

	const participantsWithAvatars = useMemo(() => {
		return participantsWithoutSelf
			.filter(p => p.avatar && p.avatar.startsWith("http"))
			.sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
			.map(p => p.avatar)
			.slice(0, 5)
	}, [participantsWithoutSelf])

	const onPress = useCallback(() => {
		if (useChatsStore.getState().selectedChats.length > 0) {
			useChatsStore.getState().setSelectedChats(prev => {
				const prevSelected = prev.some(n => n.uuid === info.item.uuid)

				if (prevSelected) {
					return prev.filter(n => n.uuid !== info.item.uuid)
				}

				return [...prev.filter(n => n.uuid !== info.item.uuid), info.item]
			})

			return
		}

		router.push(`/chat/${info.item.uuid}`)
	}, [router, info.item])

	return (
		<View className="flex-row w-full h-auto">
			<Menu
				className="flex-row w-full h-auto"
				isAnchoredToRight={true}
				info={info}
				origin="chats"
			>
				<PressableScale
					className="flex-row w-full h-auto"
					onPress={onPress}
				>
					<View className="flex-row w-full h-auto items-center px-4 pl-2 gap-2 bg-transparent">
						<View className={cn("size-2.5 rounded-full shrink-0", unreadCount > 0 ? "bg-blue-500" : "bg-transparent")} />
						{areChatsSelected && (
							<AnimatedView
								className="flex-row h-full items-center justify-center bg-transparent px-2 shrink-0"
								entering={FadeIn}
								exiting={FadeOut}
							>
								<Checkbox value={isSelected} />
							</AnimatedView>
						)}
						{participantsWithAvatars.length === 0 ? (
							<Avatar
								className="shrink-0"
								size={38}
								immediateFallback={true}
							/>
						) : participantsWithoutSelf.length <= 1 ? (
							<Avatar
								className="shrink-0"
								size={38}
								source={{
									uri: participantsWithoutSelf.at(0)?.avatar
								}}
							/>
						) : (
							<Avatar
								className="shrink-0"
								size={38}
								group={participantsWithoutSelf.length}
							/>
						)}
						<View className="flex-col border-b border-border w-full py-3 items-start gap-0.5 bg-transparent flex-1">
							<View className="flex-1 flex-row items-center gap-2 bg-transparent">
								{info.item.muted && (
									<Ionicons
										className="shrink-0"
										name="volume-mute"
										size={16}
										color={textMutedForeground.color}
									/>
								)}
								<Text
									numberOfLines={1}
									ellipsizeMode="middle"
									className={cn("text-foreground flex-1", unreadCount > 0 && "font-bold")}
								>
									{title}
								</Text>
							</View>
							{typingUsers.length > 0 ? (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className="text-xs text-muted-foreground italic"
								>
									{typingUsers.length > 1 ? `${typingUsers.join(", ")} tbd_typing...` : "tbd_typing..."}
								</Text>
							) : info.item.lastMessage && info.item.lastMessage.inner.message ? (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className={cn("text-xs", unreadCount > 0 ? "text-foreground font-bold" : "text-muted-foreground")}
								>
									{info.item.lastMessage?.inner.message ?? "tbd_no_messages_yet"}
								</Text>
							) : (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className="text-xs text-muted-foreground italic"
								>
									tbd_no_messages_yet
								</Text>
							)}
						</View>
					</View>
				</PressableScale>
			</Menu>
		</View>
	)
})

export default Chat
