import type { Chat as TChat } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import { cn, isTimestampSameMinute } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn } from "react-native-reanimated"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import { contactDisplayName } from "@/lib/utils"
import { Fragment, memo } from "react"
import { simpleDate } from "@/lib/time"
import Regexed from "@/components/chats/chat/message/regexed"
import Menu from "@/components/chats/chat/message/menu"

export const Typing = memo(({ chat }: { chat: TChat }) => {
	const typing = useChatsStore(useShallow(state => state.typing[chat.uuid] ?? []))

	const users = typing
		.map(t => t.senderId)
		.map(senderId => chat.participants.find(p => p.userId === senderId))
		.filter(Boolean)
		.map(participant => contactDisplayName(participant!))

	if (users.length === 0) {
		return null
	}

	return (
		<AnimatedView
			entering={FadeIn.delay(100)}
			className="w-full h-auto pb-2 px-4 items-start"
		>
			<View className="p-3 rounded-3xl max-w-3/4 bg-background-secondary">
				<Text className="text-xs">{users.length > 1 ? `${users.join(", ")} tbd_typing...` : "..."}</Text>
			</View>
		</AnimatedView>
	)
})

export const Message = memo(
	({
		chat,
		info,
		nextMessage,
		prevMessage
	}: {
		chat: TChat
		info: ListRenderItemInfo<ChatMessageWithInflightId>
		nextMessage?: ChatMessageWithInflightId
		prevMessage?: ChatMessageWithInflightId
	}) => {
		const stringifiedClient = useStringifiedClient()
		const isInflightError = useChatsStore(useShallow(state => state.inflightErrors[info.item.inflightId ?? ""]))

		return (
			<View
				className={cn("w-full h-auto", info.item.inner.senderId === stringifiedClient?.userId ? "items-end" : "items-start")}
				style={{
					transform: [
						{
							scaleY: -1
						}
					]
				}}
			>
				{!isTimestampSameMinute(Number(prevMessage?.sentTimestamp ?? 0), Number(info.item.sentTimestamp)) && (
					<View className="w-full items-center justify-center py-2">
						<Text
							className="text-xs text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{simpleDate(Number(info.item.sentTimestamp))}
						</Text>
					</View>
				)}
				{chat.lastFocus &&
					info.item.sentTimestamp > chat.lastFocus &&
					info.item.inner.senderId !== stringifiedClient?.userId &&
					!(prevMessage && prevMessage.sentTimestamp > chat.lastFocus) && (
						<View className="flex-1 flex-row px-4 items-center pb-2">
							<View className="flex-row items-center justify-center bg-red-500 rounded-3xl p-1 px-2">
								<Text
									className="text-xs text-white"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									tbd_new
								</Text>
							</View>
							<View className="flex-1 bg-red-500 h-[0.5px]" />
						</View>
					)}
				{chat.participants.length > 2 && info.item.inner.senderId !== stringifiedClient?.userId && (
					<View className="max-w-3/4 flex-row items-center px-4 pb-1 pl-6">
						<Text className="text-xs text-muted-foreground">
							{contactDisplayName(chat.participants.find(p => p.userId === info.item.inner.senderId)!)}
						</Text>
					</View>
				)}
				<View className="h-auto max-w-3/4">
					<Menu
						chat={chat}
						info={info}
						className="w-full h-auto pb-2 px-4"
						isAnchoredToRight={info.item.inner.senderId !== stringifiedClient?.userId}
					>
						<View
							className={cn(
								"p-3 rounded-3xl w-auto h-auto flex-row shadow-sm",
								info.item.inner.senderId === stringifiedClient?.userId
									? cn(isInflightError ? "bg-red-500" : "bg-blue-500")
									: "bg-background-secondary"
							)}
						>
							{nextMessage?.inner.senderId !== info.item.inner.senderId && (
								<Fragment>
									{info.item.inner.senderId === stringifiedClient?.userId ? (
										<View className="absolute right-2 -bottom-1.75 overflow-hidden bg-transparent w-5 h-3.75">
											<View
												className={cn(
													isInflightError ? "bg-red-500" : "bg-blue-500",
													"absolute size-6.5 bottom-0 -right-3.25 rounded-[13px]"
												)}
											/>
										</View>
									) : (
										<View
											className="absolute left-2 -bottom-1.75 overflow-hidden bg-transparent w-5 h-3.75"
											style={{
												transform: [
													{
														scaleX: -1
													}
												]
											}}
										>
											<View className="bg-background-secondary absolute size-6.5 bottom-0 -right-3.25 rounded-[13px]" />
										</View>
									)}
								</Fragment>
							)}
							<Regexed
								chat={chat}
								message={info.item}
								fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
							/>
						</View>
					</Menu>
				</View>
				{!nextMessage && <Typing chat={chat} />}
			</View>
		)
	}
)

export default Message
