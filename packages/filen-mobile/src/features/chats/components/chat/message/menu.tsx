import { type Chat as TChat } from "@/types"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import { useSecureStore } from "@/lib/secureStore"
import { chatInputValueKey, chatReplyToKey, chatEditMessageKey } from "@/features/chats/chatDrafts"
import useChatsStore, { type ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { copyToClipboard } from "@/lib/clipboard"
import { isBlocked } from "@filen/shared"
import { useStringifiedClient } from "@/lib/auth"
import chats from "@/features/chats/chats"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/chatsInflight"
import { simpleDate } from "@/lib/time"
import events from "@/lib/events"
import { useTranslation } from "react-i18next"
import { confirmedAction } from "@/lib/confirmedAction"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import logger from "@/lib/logger"

export const Menu = ({
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
	const [, setChatReplyTo] = useSecureStore<ChatMessageWithInflightId | null>(chatReplyToKey(chat.uuid), null)
	const [, setChatEditMessage] = useSecureStore<ChatMessageWithInflightId | null>(chatEditMessageKey(chat.uuid), null)
	const stringifiedClient = useStringifiedClient()
	const [, setChatInputValue] = useSecureStore<string>(chatInputValueKey(chat.uuid), "")
	const isFailedInflight = useChatsStore(useShallow(state => state.inflightErrors[info.item.inflightId ?? ""] !== undefined))

	const isOwner = info.item.inner.senderId === stringifiedClient?.userId
	const blocked = useBlockedUsers()
	const senderBlocked = isBlocked({ userId: info.item.inner.senderId, email: info.item.inner.senderEmail }, blocked)

	const blockButton = buildBlockToggleMenuAction({
		t,
		isBlocked: false,
		target: {
			userId: info.item.inner.senderId,
			email: info.item.inner.senderEmail,
			avatar: info.item.inner.senderAvatar,
			nickName: info.item.inner.senderNickName,
			timestamp: info.item.sentTimestamp
		}
	})

	const deleteButton = {
		id: "delete",
		title: t("delete"),
		icon: "delete" as const,
		destructive: true,
		requiresOnline: true,
		onPress: confirmedAction({
			promptTitle: t("delete_message"),
			promptMessage: t("delete_message_confirmation"),
			promptOkText: t("delete"),
			action: () =>
				chats.deleteMessage({
					chat,
					message: info.item
				})
		})
	} satisfies MenuButton

	const copyButton = {
		id: "copy",
		title: t("copy"),
		icon: "copy" as const,
		onPress: async () => {
			if (!info.item.inner.message) {
				return
			}

			await copyToClipboard(info.item.inner.message, t("copied_to_clipboard"), "chats", "copy message to clipboard failed")
		}
	} satisfies MenuButton

	// D4c: a failed send only exists locally (it was never committed server-side), so the
	// server-bound actions (reply/edit/delete) would target a message uuid the server doesn't
	// know. Offer retry (re-queue + kick the sync) and remove (discard the failed send) instead.
	const buttons = isFailedInflight
		? ([
				copyButton,
				{
					id: "retry",
					title: t("retry"),
					icon: "restore" as const,
					onPress: () => {
						retryInflightMessage({
							chat,
							message: info.item
						}).catch(e => logger.warn("chats", "retryInflightMessage failed", { error: e }))
					}
				},
				{
					id: "remove",
					title: t("remove"),
					icon: "trash" as const,
					destructive: true,
					onPress: () => {
						removeInflightMessage({
							chat,
							message: info.item
						}).catch(e => logger.warn("chats", "removeInflightMessage failed", { error: e }))
					}
				}
			] satisfies MenuButton[])
		: info.item.undecryptable
			? isOwner
				? [deleteButton]
				: ([] as MenuButton[])
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
					copyButton,
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
						: []),
					...(!isOwner && !senderBlocked ? [blockButton] : [])
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

export default Menu
