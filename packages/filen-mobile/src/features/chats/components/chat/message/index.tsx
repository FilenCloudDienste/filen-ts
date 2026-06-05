import { useTranslation } from "react-i18next"
import { type Chat as TChat } from "@/types"
import View from "@/components/ui/view"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import { cn, isTimestampSameMinute } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { contactDisplayName } from "@/lib/utils"
import { extractLinks, safeParseUrl } from "@/lib/linkParser"
import { Fragment, useMemo } from "react"
import { simpleDate } from "@/lib/time"
import Regexed from "@/features/chats/components/chat/message/regexed"
import Menu from "@/features/chats/components/chat/message/menu"
import { messageDisplayBody } from "@/lib/decryption"
import Typing from "@/features/chats/components/chat/message/typing"
import Attachments from "@/features/chats/components/chat/message/attachments"

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
	const isInflightError = useChatsStore(useShallow(state => state.inflightErrors[info.item.inflightId ?? ""]))

	const isMessageOnlyLink = useMemo(() => computeIsMessageOnlyLink(info.item.inner.message), [info.item.inner.message])

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
								{t("new")}
							</Text>
						</View>
						<View className="flex-1 bg-red-500 h-[0.5px]" />
					</View>
				)}
			{chat.participants.length > 2 && info.item.inner.senderId !== stringifiedClient?.userId && (
				<View className="max-w-3/4 flex-row items-center px-4 pb-1 pl-6">
					<Text className="text-xs text-muted-foreground">
						{(() => {
							const senderParticipant = chat.participants.find(p => p.userId === info.item.inner.senderId)

							return senderParticipant ? contactDisplayName(senderParticipant) : t("unknown")
						})()}
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
												info.item.inner.senderId === stringifiedClient?.userId ? "text-white" : "text-foreground"
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
			{!nextMessage && <Typing chat={chat} />}
		</View>
	)
}

export default Message
