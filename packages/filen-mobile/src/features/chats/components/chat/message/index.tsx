import { useTranslation } from "react-i18next"
import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import { cn, isTimestampSameMinute } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { messageSenderLabel } from "@/features/chats/utils"
import { extractLinks, safeParseUrl } from "@/lib/linkParser"
import { Fragment } from "react"
import { formatRelativeTime } from "@/lib/time"
import Regexed from "@/features/chats/components/chat/message/regexed"
import Menu from "@/features/chats/components/chat/message/menu"
import { messageDisplayBody } from "@/lib/decryption"
import Typing from "@/features/chats/components/chat/message/typing"
import Attachments from "@/features/chats/components/chat/message/attachments"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { isBlocked } from "@/features/contacts/blockedSelectors"
import useRevealedBlockedMessages from "@/features/chats/store/useRevealedBlockedMessages.store"
import { PressableOpacity } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"

function computeIsMessageOnlyLink(message: string | undefined): boolean {
	if (!message) {
		return false
	}

	const normalized = message.trim().toLowerCase()
	const links = extractLinks(normalized).map(link => safeParseUrl(link.url))
	const link = links.length === 1 ? links[0] : null

	if (!link) {
		return false
	}

	return link.href.trim().toLowerCase() === normalized
}

const Message = ({
	chat,
	info,
	nextMessage,
	prevMessage,
	layout
}: {
	chat: TChat
	info: ListRenderItemInfo<ChatMessageWithInflightId>
	nextMessage?: ChatMessageWithInflightId
	prevMessage?: ChatMessageWithInflightId
	layout: {
		width: number
		height: number
	}
}) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const isInflightError = useChatsStore(useShallow(state => state.inflightErrors[info.item.inflightId ?? ""] !== undefined))

	const isMessageOnlyLink = computeIsMessageOnlyLink(info.item.inner.message)
	const blocked = useBlockedUsers()
	const senderBlocked = isBlocked({ userId: info.item.inner.senderId, email: info.item.inner.senderEmail }, blocked)
	const isRevealed = useRevealedBlockedMessages(state => state.revealed.has(info.item.inner.uuid))
	const showTombstone = senderBlocked && !isRevealed
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const senderLabel = senderBlocked ? null : messageSenderLabel(chat, info.item, stringifiedClient?.userId, t("unknown"))

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
						{formatRelativeTime(Number(info.item.sentTimestamp), t)}
					</Text>
				</View>
			)}
			{chat.lastFocus &&
				info.item.sentTimestamp > chat.lastFocus &&
				info.item.inner.senderId !== stringifiedClient?.userId &&
				!senderBlocked &&
				!(prevMessage && prevMessage.sentTimestamp > chat.lastFocus) && (
					<View className="flex-1 flex-row px-4 items-center pb-2">
						<View className="flex-row items-center justify-center bg-red-500 rounded-3xl p-1 px-2">
							<Text
								className="text-xs text-white"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{t("new")}
							</Text>
						</View>
						<View className="flex-1 bg-red-500 h-px" />
					</View>
				)}
			{senderLabel !== null && (
				<View className="max-w-3/4 flex-row items-center px-4 pb-1 pl-6">
					<Text className="text-xs text-muted-foreground">{senderLabel}</Text>
				</View>
			)}
			{showTombstone && (
				<View className="h-auto max-w-3/4 items-start">
					<PressableOpacity
						className="flex-row items-center gap-2 px-4 py-2"
						onPress={() => useRevealedBlockedMessages.getState().reveal(info.item.inner.uuid)}
					>
						<Ionicons
							name="ban-outline"
							size={14}
							color={textMutedForeground.color}
						/>
						<Text className="text-xs text-muted-foreground italic">{t("message_hidden_blocked")}</Text>
						<Text className="text-xs text-blue-500">{t("message_hidden_blocked_show")}</Text>
					</PressableOpacity>
				</View>
			)}
			{!showTombstone && (
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
							{isMessageOnlyLink ? (
								<Attachments
									chat={chat}
									message={info.item}
									fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
									single={true}
									layout={layout}
								/>
							) : (
								<View className="flex-col bg-transparent w-auto h-auto">
									<View className="bg-transparent w-auto h-auto flex-row">
										{info.item.undecryptable ? (
											<Text
												className={cn(
													"text-sm shrink-0 flex-wrap text-wrap items-center break-all",
													info.item.inner.senderId === stringifiedClient?.userId
														? "text-white"
														: "text-foreground"
												)}
											>
												{messageDisplayBody(info.item)}
											</Text>
										) : (
											<Regexed
												chat={chat}
												message={info.item}
												fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
											/>
										)}
									</View>
									<Attachments
										chat={chat}
										message={info.item}
										fromSelf={info.item.inner.senderId === stringifiedClient?.userId}
										single={false}
										layout={layout}
									/>
								</View>
							)}
						</View>
					</Menu>
				</View>
			)}
			{!nextMessage && <Typing chat={chat} />}
		</View>
	)
}

export default Message
