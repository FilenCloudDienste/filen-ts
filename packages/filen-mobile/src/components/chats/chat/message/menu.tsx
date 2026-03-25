import type { Chat as TChat } from "@filen/sdk-rs"
import { memo, useMemo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import { useSecureStore } from "@/lib/secureStore"
import useChatsStore, { type ChatMessageWithInflightId } from "@/stores/useChats.store"
import * as Clipboard from "expo-clipboard"
import alerts from "@/lib/alerts"
import { run } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import chats from "@/lib/chats"
import prompts from "@/lib/prompts"
import { simpleDate } from "@/lib/time"
import events from "@/lib/events"

export const Menu = memo(
	({
		chat,
		info,
		children,
		className,
		isAnchoredToRight
	}: {
		chat: TChat
		info: ListRenderItemInfo<ChatMessageWithInflightId>
		children: React.ReactNode
		className?: string
		isAnchoredToRight?: boolean
	}) => {
		const [, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
		const [, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(`chatEditMessage:${chat.uuid}`, null)
		const stringifiedClient = useStringifiedClient()
		const [, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")

		const buttons = useMemo(() => {
			return [
				{
					id: "reply",
					title: "tbd_reply",
					onPress: () => {
						setChatReplyTo(info.item)

						events.emit("focusChatInput", {
							chatUuid: chat.uuid
						})
					}
				},
				{
					id: "copy",
					title: "tbd_copy",
					onPress: async () => {
						const result = await run(async () => {
							if (!info.item.inner.message) {
								return
							}

							return await Clipboard.setStringAsync(info.item.inner.message)
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}

						alerts.normal("tbd_copied_to_clipboard")
					}
				},
				...(info.item.inner.senderId === stringifiedClient?.userId
					? [
							{
								id: "edit",
								title: "tbd_edit",
								onPress: () => {
									if (!info.item.inner.message) {
										return
									}

									setChatEditMessage(info.item)
									setChatInputValue(info.item.inner.message)

									useChatsStore.getState().setInputSelection({
										start: 0,
										end: 0
									})

									events.emit("focusChatInput", {
										chatUuid: chat.uuid
									})
								}
							},
							{
								id: "delete",
								title: "tbd_delete",
								destructive: true,
								onPress: async () => {
									const promptResponse = await run(async () => {
										return await prompts.alert({
											title: "tbd_delete_message",
											message: "tbd_delete_message_confirmation",
											cancelText: "tbd_cancel",
											okText: "tbd_delete"
										})
									})

									if (!promptResponse.success) {
										console.error(promptResponse.error)
										alerts.error(promptResponse.error)

										return
									}

									if (promptResponse.data.cancelled) {
										return
									}

									const result = await runWithLoading(async () => {
										await chats.deleteMessage({
											chat,
											message: info.item
										})
									})

									if (!result.success) {
										console.error(result.error)
										alerts.error(result.error)

										return
									}
								}
							}
						]
					: [])
			] satisfies MenuButton[]
		}, [setChatReplyTo, info.item, stringifiedClient?.userId, chat, setChatEditMessage, setChatInputValue])

		return (
			<MenuComponent
				type="context"
				title={simpleDate(Number(info.item.sentTimestamp))}
				buttons={buttons}
				className={className}
				isAnchoredToRight={isAnchoredToRight}
			>
				{children}
			</MenuComponent>
		)
	}
)

export default Menu
