import { type Chat as TChat } from "@/types"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import chats from "@/features/chats/chats"
import { selectContacts } from "@/features/contacts/contactsSelect"
import { router } from "expo-router"
import useChatsStore from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import useChatUnreadCount from "@/features/chats/hooks/useChatUnreadCount"
import { serialize } from "@/lib/serializer"
import { t } from "@/lib/i18n"
import { confirmedChatAction } from "@/features/chats/components/confirmedChatAction"

export type ChatMenuOrigin = "chats" | "search" | "chat"

// The owner "delete chat" and non-owner "leave chat" buttons are emitted in both the
// undecryptable and the normal branch — build them once here so the prompt copy, icons and
// detail-route dismissal stay in lockstep.
function deleteChatButton(chat: TChat): MenuButton {
	return {
		id: "delete",
		requiresOnline: true,
		title: t("delete"),
		destructive: true,
		icon: "delete",
		onPress: confirmedChatAction({
			promptTitle: t("delete_chat"),
			promptMessage: t("delete_chat_confirmation"),
			promptOkText: t("delete"),
			action: () => chats.delete({ chat }),
			dismissPathnamePrefix: `/chat/${chat.uuid}`
		})
	}
}

function leaveChatButton(chat: TChat): MenuButton {
	return {
		id: "leave",
		requiresOnline: true,
		title: t("leave"),
		destructive: true,
		icon: "exit",
		onPress: confirmedChatAction({
			promptTitle: t("leave_chat"),
			promptMessage: t("leave_chat_confirmation"),
			promptOkText: t("leave"),
			action: () => chats.leave({ chat }),
			dismissPathnamePrefix: `/chat/${chat.uuid}`
		})
	}
}

export function createMenuButtons({
	chat,
	userId,
	origin,
	isSelected = false,
	unreadCount
}: {
	chat: TChat
	userId: bigint
	origin: ChatMenuOrigin
	// Optional: detail-route callers (origin === "chat") don't have a meaningful
	// selection state — the select/deselect entry is hidden for them anyway, so
	// they can omit it. List-row callers still pass it.
	isSelected?: boolean
	unreadCount: number
}): MenuButton[] {
	const isOwner = chat.ownerId === userId

	if (chat.undecryptable) {
		const selectButton: MenuButton[] =
			origin !== "chat"
				? [
						{
							id: isSelected ? "deselect" : "select",
							title: isSelected ? t("deselect") : t("select"),
							icon: "select",
							checked: isSelected,
							onPress: () => {
								useChatsStore.getState().toggleSelectedChat(chat)
							}
						}
					]
				: []

		if (isOwner) {
			return [...selectButton, deleteChatButton(chat)]
		}

		return [...selectButton, leaveChatButton(chat)]
	}

	return [
		...(origin !== "chat"
			? [
					{
						id: isSelected ? "deselect" : "select",
						title: isSelected ? t("deselect") : t("select"),
						icon: "select",
						checked: isSelected,
						onPress: () => {
							useChatsStore.getState().toggleSelectedChat(chat)
						}
					} satisfies MenuButton
				]
			: []),
		...(unreadCount > 0
			? [
					{
						id: "markAsRead",
						title: t("mark_as_read"),
						icon: "envelopeOpen",
						requiresOnline: true,
						onPress: async () => {
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
						}
					} satisfies MenuButton
				]
			: []),
		{
			id: "muted",
			requiresOnline: true,
			title: t("muted"),
			icon: "mute",
			checked: chat.muted,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					await chats.mute({
						chat,
						mute: !chat.muted
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		},
		{
			id: "participants",
			title: t("participants"),
			icon: "users",
			onPress: () => {
				router.push({
					pathname: "/chatParticipants",
					params: {
						chat: serialize(chat)
					}
				})
			}
		},
		...(isOwner
			? ([
					{
						id: "addParticipant",
						requiresOnline: true,
						title: t("add_participant"),
						icon: "users",
						onPress: async () => {
							const selectContactsResult = await selectContacts({
								multiple: true,
								userIdsToExclude: chat.participants.map(p => Number(p.userId))
							})

							if (selectContactsResult.cancelled) {
								return
							}

							const result = await runWithLoading(async () => {
								return await Promise.all(
									selectContactsResult.selectedContacts.map(async contact => {
										return await chats.addParticipant({
											chat,
											contact
										})
									})
								)
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}
						}
					} satisfies MenuButton,
					{
						id: "editName",
						requiresOnline: true,
						title: t("edit_name"),
						icon: "edit",
						onPress: async () => {
							const promptResult = await run(async () => {
								return await prompts.input({
									title: t("edit_chat_name"),
									message: t("enter_chat_name"),
									cancelText: t("cancel"),
									okText: t("save")
								})
							})

							if (!promptResult.success) {
								console.error(promptResult.error)
								alerts.error(promptResult.error)

								return
							}

							if (promptResult.data.cancelled || promptResult.data.type !== "string") {
								return
							}

							const newName = promptResult.data.value.trim()

							if (newName.length === 0) {
								return
							}

							const result = await runWithLoading(async () => {
								await chats.rename({
									chat,
									newName: newName
								})
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}
						}
					},
					deleteChatButton(chat)
				] satisfies MenuButton[])
			: ([leaveChatButton(chat)] satisfies MenuButton[]))
	] satisfies MenuButton[]
}

const Menu = ({
	info,
	children,
	className,
	isAnchoredToRight,
	origin
}: {
	info: ListRenderItemInfo<TChat>
	children: React.ReactNode
	className?: string
	isAnchoredToRight?: boolean
	origin: ChatMenuOrigin
}) => {
	const stringifiedClient = useStringifiedClient()
	const isSelected = useChatsStore(useShallow(state => state.selectedChats.some(n => n.uuid === info.item.uuid)))
	const chatUnreadCount = useChatUnreadCount(info.item)

	const buttons = stringifiedClient
		? createMenuButtons({
				chat: info.item,
				userId: stringifiedClient.userId,
				origin,
				isSelected,
				unreadCount: chatUnreadCount
			})
		: []

	return (
		<MenuComponent
			type="context"
			buttons={buttons}
			className={className}
			isAnchoredToRight={isAnchoredToRight}
		>
			{children}
		</MenuComponent>
	)
}

export default Menu
