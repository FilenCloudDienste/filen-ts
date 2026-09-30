import Text from "@/components/ui/text"
import { useState } from "react"
import { Platform } from "react-native"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import ChatAvatar from "@/features/chats/components/chatAvatar"
import { PressableScale } from "@/components/ui/pressables"
import Menu from "@/features/chats/components/list/chat/menu"
import { chatDisplayName } from "@/lib/decryption"
import { router } from "@/lib/router"
import { useStringifiedClient } from "@/lib/auth"
import { cn, isBlocked } from "@filen/shared"
import useChatUnreadCount from "@/features/chats/hooks/useChatUnreadCount"
import useChatsStore from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { Checkbox } from "@/components/ui/checkbox"
import { useTranslation } from "react-i18next"
import { formatRelativeTime, simpleDateNoTime } from "@/lib/time"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { typingLabel, typingNames } from "@/features/chats/utils"

const Chat = ({ info }: { info: ListRenderItemInfo<TChat> }) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const unreadCount = useChatUnreadCount(info.item)
	const blocked = useBlockedUsers()
	const lastMessageFromBlocked =
		!!info.item.lastMessage &&
		isBlocked({ userId: info.item.lastMessage.inner.senderId, email: info.item.lastMessage.inner.senderEmail }, blocked)
	const typing = useChatsStore(useShallow(state => state.typing[info.item.uuid] ?? []))
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { isSelected, areChatsSelected } = useChatsStore(
		useShallow(state => ({
			isSelected: state.selectedChats.some(n => n.uuid === info.item.uuid),
			areChatsSelected: state.selectedChats.length > 0
		}))
	)
	const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false)

	const typingUsers = typingNames(typing, info.item.participants)

	const title = stringifiedClient ? chatDisplayName(info.item, stringifiedClient.userId, t("just_you")) : ""

	const onPress = () => {
		if (useChatsStore.getState().selectedChats.length > 0) {
			useChatsStore.getState().toggleSelectedChat(info.item)

			return
		}

		router.push(`/chat/${info.item.uuid}`)
	}

	return (
		<View
			className={cn(
				"flex-row w-full h-auto",
				Platform.OS === "android" && isMenuOpen ? "bg-background-secondary" : "bg-transparent"
			)}
		>
			<Menu
				className="flex-row w-full h-auto"
				isAnchoredToRight={true}
				info={info}
				origin="chats"
				previewBackground={true}
				onOpenMenu={() => setIsMenuOpen(true)}
				onCloseMenu={() => setIsMenuOpen(false)}
			>
				<PressableScale
					className="flex-row w-full h-auto"
					onPress={onPress}
				>
					<View className="flex-row w-full h-auto items-center px-4 pl-2 gap-2 bg-transparent">
						<View className={cn("size-2.5 rounded-full shrink-0", unreadCount > 0 ? "bg-blue-500" : "bg-transparent")} />
						{areChatsSelected && (
							<View className="flex-row h-full items-center justify-center bg-transparent px-2 shrink-0">
								<Checkbox value={isSelected} />
							</View>
						)}
						<ChatAvatar
							className="shrink-0"
							size={38}
							participants={info.item.participants}
							selfUserId={stringifiedClient?.userId}
						/>
						<View className="flex-col border-b border-separator w-full py-3 items-start gap-0.5 bg-transparent flex-1">
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
								{info.item.lastMessage && (
									<Text
										numberOfLines={1}
										className={cn("text-xs shrink-0", unreadCount > 0 ? "text-foreground" : "text-muted-foreground")}
									>
										{formatRelativeTime(Number(info.item.lastMessage.sentTimestamp), t, {
											absolute: simpleDateNoTime
										})}
									</Text>
								)}
							</View>
							{typingUsers.length > 0 ? (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className="text-xs text-muted-foreground italic"
								>
									{typingLabel(typingUsers, t)}
								</Text>
							) : info.item.lastMessage && info.item.lastMessage.inner.message ? (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className={cn(
										"text-xs",
										lastMessageFromBlocked
											? "text-muted-foreground italic"
											: unreadCount > 0
												? "text-foreground font-bold"
												: "text-muted-foreground"
									)}
								>
									{lastMessageFromBlocked ? t("message_hidden_blocked") : info.item.lastMessage.inner.message}
								</Text>
							) : (
								<Text
									numberOfLines={1}
									ellipsizeMode="tail"
									className="text-xs text-muted-foreground italic"
								>
									{t("no_messages_yet")}
								</Text>
							)}
						</View>
					</View>
				</PressableScale>
			</Menu>
		</View>
	)
}

export default Chat
