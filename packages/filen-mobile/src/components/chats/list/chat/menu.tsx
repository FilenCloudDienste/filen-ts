import type { Chat as TChat, ChatParticipant } from "@filen/sdk-rs"
import { memo, useMemo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run, fastLocaleCompare } from "@filen/utils"
import alerts from "@/lib/alerts"
import chats from "@/lib/chats"
import { Platform } from "react-native"
import { actionSheet } from "@/providers/actionSheet.provider"
import { randomUUID } from "expo-crypto"
import { contactDisplayName } from "@/lib/utils"
import { router } from "expo-router"
import useAppStore from "@/stores/useApp.store"
import useChatsStore from "@/stores/useChats.store"
import { useShallow } from "zustand/shallow"
import useChatUnreadCount from "@/hooks/useChatUnreadCount"
import { selectContacts } from "@/routes/contacts"

export type ChatMenuOrigin = "chats" | "search" | "chat"

export function createMenuButtons({
	chat,
	userId,
	origin,
	isSelected,
	unreadCount
}: {
	chat: TChat
	userId: bigint
	origin: ChatMenuOrigin
	isSelected: boolean
	unreadCount: number
}): MenuButton[] {
	return [
		...(origin !== "chat"
			? [
					{
						id: isSelected ? "deselect" : "select",
						title: isSelected ? "tbd_deselect" : "tbd_select",
						icon: "select",
						checked: isSelected,
						onPress: () => {
							useChatsStore.getState().setSelectedChats(prev => {
								if (isSelected) {
									return prev.filter(n => n.uuid !== chat.uuid)
								} else {
									return [...prev.filter(n => n.uuid !== chat.uuid), chat]
								}
							})
						}
					} satisfies MenuButton
				]
			: []),
		...(unreadCount > 0
			? [
					{
						id: "markAsRead",
						title: "tbd_mark_as_read",
						icon: "archive",
						checked: isSelected,
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
			id: "participants",
			title: "tbd_participants",
			icon: "users",
			subButtons: (
				[
					{
						type: "add" as const
					},
					...chat.participants
						.filter(participant => participant.userId !== userId)
						.map(participant => ({
							type: "participant" as const,
							participant
						}))
						.sort((a, b) => fastLocaleCompare(a.participant.email, b.participant.email))
				] satisfies (
					| {
							type: "add"
					  }
					| {
							type: "participant"
							participant: ChatParticipant
					  }
				)[]
			).map(subButton => {
				if (subButton.type === "add") {
					return {
						id: "addParticipant",
						title: "tbd_addParticipant",
						keepMenuOpenOnPress: Platform.OS === "android",
						icon: "plus",
						onPress: async () => {
							const selectContactsResult = await selectContacts({
								multiple: true,
								userIdsToExclude: chat.participants.map(participant => Number(participant.userId))
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
					} satisfies MenuButton
				}

				return {
					id: `participant_${subButton.participant.userId}`,
					title: Platform.select({
						ios: contactDisplayName(subButton.participant),
						default: subButton.participant.email
					}),
					subTitle: subButton.participant.email,
					keepMenuOpenOnPress: Platform.OS === "android",
					icon: "user",
					destructive: chat.ownerId === subButton.participant.userId,
					onPress: () => {
						if (userId === subButton.participant.userId || chat.ownerId !== userId) {
							return
						}

						actionSheet.show({
							buttons: [
								{
									title: "tbd_remove_participant",
									destructive: true,
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: "tbd_remove_participant",
												message: "tbd_are_you_sure_remove_participant",
												cancelText: "tbd_cancel",
												okText: "tbd_remove"
											})
										})

										if (!promptResult.success) {
											console.error(promptResult.error)
											alerts.error(promptResult.error)

											return
										}

										if (promptResult.data.cancelled) {
											return
										}

										const result = await runWithLoading(async () => {
											await chats.removeParticipant({
												chat,
												contact: {
													uuid: randomUUID(),
													userId: subButton.participant.userId,
													email: subButton.participant.email,
													avatar: subButton.participant.avatar,
													nickName: subButton.participant.nickName,
													lastActive: subButton.participant.lastActive,
													timestamp: subButton.participant.lastActive,
													publicKey: randomUUID()
												}
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
									title: "tbd_cancel",
									cancel: true
								}
							]
						})
					}
				} satisfies MenuButton
			})
		},
		{
			id: "muted",
			title: "tbd_muted",
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
		...(chat.ownerId === userId
			? ([
					{
						id: "editName",
						title: "tbd_edit_name",
						icon: "edit",
						onPress: async () => {
							const promptResult = await run(async () => {
								return await prompts.input({
									title: "tbd_edit_chat_name",
									message: "tbd_enter_chat_name",
									cancelText: "tbd_cancel",
									okText: "tbd_save"
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
					{
						id: "delete",
						title: "tbd_delete",
						destructive: true,
						icon: "delete",
						onPress: async () => {
							const promptResponse = await run(async () => {
								return await prompts.alert({
									title: "tbd_delete_chat",
									message: "tbd_delete_chat_confirmation",
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
								await chats.delete({
									chat
								})
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}

							if (useAppStore.getState().pathname.startsWith(`/chat/${chat.uuid}`) && router.canGoBack()) {
								router.back()
							}
						}
					}
				] satisfies MenuButton[])
			: ([
					{
						id: "leave",
						title: "tbd_leave",
						destructive: true,
						icon: "delete",
						onPress: async () => {
							const promptResponse = await run(async () => {
								return await prompts.alert({
									title: "tbd_leave_chat",
									message: "tbd_leave_chat_confirmation",
									cancelText: "tbd_cancel",
									okText: "tbd_leave"
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
								await chats.leave({
									chat
								})
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}

							if (useAppStore.getState().pathname.startsWith(`/chat/${chat.uuid}`) && router.canGoBack()) {
								router.back()
							}
						}
					}
				] satisfies MenuButton[]))
	] satisfies MenuButton[]
}

export const Menu = memo(
	({
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

		const buttons = useMemo(() => {
			if (!stringifiedClient) {
				return []
			}

			return createMenuButtons({
				chat: info.item,
				userId: stringifiedClient.userId,
				origin,
				isSelected,
				unreadCount: chatUnreadCount
			})
		}, [info.item, stringifiedClient, origin, isSelected, chatUnreadCount])

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
)

export default Menu
