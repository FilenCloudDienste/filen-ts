import { type Chat as TChat } from "@/types"
import { memo } from "react"
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
import { useTranslation } from "react-i18next"

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
		const { t } = useTranslation()
		const [, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(`chatReplyTo:${chat.uuid}`, null)
		const [, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(`chatEditMessage:${chat.uuid}`, null)
		const stringifiedClient = useStringifiedClient()
		const [, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")

		const isOwner = info.item.inner.senderId === stringifiedClient?.userId

		const deleteButton = {
			id: "delete",
			title: t("delete"),
			icon: "delete" as const,
			destructive: true,
			requiresOnline: true,
			onPress: async () => {
				const promptResponse = await run(async () => {
					return await prompts.alert({
						title: t("delete_message"),
						message: t("delete_message_confirmation"),
						cancelText: t("cancel"),
						okText: t("delete"),
						destructive: true
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
		} satisfies MenuButton

		const buttons = info.item.undecryptable
			? (isOwner ? [deleteButton] : ([] as MenuButton[]))
			: ([
					{
						id: "reply",
						title: t("reply"),
						icon: "reply" as const,
						onPress: () => {
							setChatReplyTo(info.item)

							events.emit("focusChatInput", {
								chatUuid: chat.uuid
							})
						}
					},
					{
						id: "copy",
						title: t("copy"),
						icon: "copy" as const,
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

							alerts.normal(t("copied_to_clipboard"))
						}
					},
					...(isOwner
						? [
								{
									id: "edit",
									title: t("edit"),
									icon: "edit" as const,
									requiresOnline: true,
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
								deleteButton
							]
						: [])
				] satisfies MenuButton[])

		return (
			<MenuComponent
				type="context"
				title={simpleDate(Number(info.item.sentTimestamp))}
				buttons={buttons}
				disabled={buttons.length === 0}
				className={className}
				isAnchoredToRight={isAnchoredToRight}
			>
				{children}
			</MenuComponent>
		)
	}
)

export default Menu
