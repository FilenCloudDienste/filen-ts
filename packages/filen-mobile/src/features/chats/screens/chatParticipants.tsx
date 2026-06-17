import { Platform } from "react-native"
import { useLocalSearchParams, router, useFocusEffect } from "expo-router"
import { useTranslation } from "react-i18next"
import { deserializeRouteParam } from "@/lib/serializer"
import { type HeaderItem } from "@/components/ui/header"
import { useCallback } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import useIsOnline from "@/hooks/useIsOnline"
import prompts from "@/lib/prompts"
import type { ChatParticipant } from "@filen/sdk-rs"
import { type Chat } from "@/types"
import { type MenuButton } from "@/components/ui/menu"
import { contactDisplayName } from "@/lib/utils"
import useChatsQuery from "@/features/chats/queries/useChats.query"
import chats from "@/features/chats/chats"
import { selectContacts } from "@/features/contacts/contactsSelect"
import DismissStack from "@/components/dismissStack"
import useChatParticipantsStore from "@/features/chats/store/useChatParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import ParticipantList from "@/components/participants/participantList"
import { type ParticipantRowProps } from "@/components/participants/participantRow"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { contactsQueryGet } from "@/features/contacts/queries/useContacts.query"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"
import logger from "@/lib/logger"

const ChatParticipants = () => {
	const { t } = useTranslation()
	const { chat: chatSerialized } = useLocalSearchParams<{
		chat?: string
	}>()
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const isOnline = useIsOnline()
	const selectedChatParticipants = useChatParticipantsStore(useShallow(state => state.selectedChatParticipants))
	const blocked = useBlockedUsers()

	useFocusEffect(
		useCallback(() => {
			useChatParticipantsStore.getState().clearSelectedChatParticipants()

			return () => {
				useChatParticipantsStore.getState().clearSelectedChatParticipants()
			}
		}, [])
	)

	const chatParsed = deserializeRouteParam<Chat>(chatSerialized)

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	const chat = chatParsed && chatsQuery.status === "success" ? (chatsQuery.data.find(n => n.uuid === chatParsed.uuid) ?? null) : null

	const participants = chat ? chat.participants.filter(p => p.userId !== stringifiedClient?.userId) : []
	const isOwner = chat?.ownerId === stringifiedClient?.userId

	if (!chat) {
		return <DismissStack />
	}

	const inSelectionMode = isOwner && selectedChatParticipants.length > 0

	const toRowProps = (participant: ChatParticipant): ParticipantRowProps => {
		const isSelected = selectedChatParticipants.some(p => p.userId === participant.userId)
		const areOthersSelected = selectedChatParticipants.length > 0
		const isParticipantBlocked = blocked.userIds.has(participant.userId)
		const blockedUuid = isParticipantBlocked ? contactsQueryGet()?.blocked.find(b => b.userId === participant.userId)?.uuid : undefined

		return {
			email: participant.email,
			displayName: contactDisplayName(participant),
			avatar: participant.avatar,
			// Chat participants are remove-only — no read/write permission concept.
			permission: undefined,
			blocked: isParticipantBlocked,
			extraMenuActions: [
				buildBlockToggleMenuAction({
					t,
					isBlocked: isParticipantBlocked,
					blockedUuid,
					userId: participant.userId,
					email: participant.email,
					avatar: participant.avatar,
					nickName: participant.nickName,
					timestamp: participant.added
				})
			],
			ownerActions: isOwner
				? {
						isSelected,
						areOthersSelected,
						onToggleSelect: () => {
							useChatParticipantsStore.getState().toggleSelectedChatParticipant(participant)
						},
						menuActions: [
							{
								id: "remove",
								title: t("remove"),
								destructive: true,
								icon: "delete",
								requiresOnline: true,
								onPress: async () => {
									const promptResponse = await run(async () => {
										return await prompts.alert({
											title: t("remove_participant"),
											message: t("remove_participant_confirmation"),
											cancelText: t("cancel"),
											okText: t("remove"),
											destructive: true
										})
									})

									if (!promptResponse.success) {
										logger.error("chats", "remove participant prompt failed", { error: promptResponse.error })
										alerts.error(promptResponse.error)

										return
									}

									if (promptResponse.data.cancelled) {
										return
									}

									const result = await runWithLoading(async () => {
										return await chats.removeParticipant({
											chat,
											participant
										})
									})

									if (!result.success) {
										logger.error("chats", "removeParticipant failed", { error: result.error })
										alerts.error(result.error)

										return
									}
								}
							}
						] satisfies MenuButton[]
					}
				: undefined
		}
	}

	const headerLeftItems: HeaderItem[] = (() => {
		if (inSelectionMode) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useChatParticipantsStore.getState().clearSelectedChatParticipants()
						}
					}
				}
			]
		}

		if (Platform.OS === "ios") {
			return [
				{
					type: "button",
					icon: {
						name: "close",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							router.back()
						}
					}
				}
			]
		}

		return []
	})()

	const headerRightItems: HeaderItem[] | undefined = (() => {
		if (inSelectionMode) {
			const menuButtons: MenuButton[] = [
				{
					id: "selectAll",
					title: selectedChatParticipants.length === participants.length ? t("deselect_all") : t("select_all"),
					icon: "select",
					onPress: () => {
						if (selectedChatParticipants.length === participants.length) {
							useChatParticipantsStore.getState().clearSelectedChatParticipants()

							return
						}

						useChatParticipantsStore.getState().selectAllChatParticipants(participants)
					}
				},
				{
					id: "bulkRemove",
					title: t("remove_selected"),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedChatParticipants,
							clearSelection: () => useChatParticipantsStore.getState().clearSelectedChatParticipants(),
							confirm: {
								title: t("remove_selected"),
								message: t("remove_selected_participants_confirmation"),
								okText: t("remove"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: participant =>
								chats.removeParticipant({
									chat,
									participant
								})
						})
					}
				}
			]

			return [
				{
					type: "menu",
					props: {
						type: "dropdown",
						hitSlop: 20,
						buttons: menuButtons
					},
					triggerProps: {
						hitSlop: 20
					},
					icon: {
						name: "ellipsis-horizontal",
						size: 24,
						color: textForeground.color
					}
				}
			]
		}

		if (!isOwner) {
			return undefined
		}

		return [
			{
				type: "button",
				icon: {
					name: "add-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					enabled: isOnline,
					onPress: async () => {
						const selectContactsResult = await selectContacts({
							multiple: true,
							userIdsToExclude: chat.participants.map(p => Number(p.userId))
						})

						if (selectContactsResult.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							return await chats.addParticipants({
								chat,
								contacts: selectContactsResult.selectedContacts
							})
						})

						if (!result.success) {
							logger.error("chats", "addParticipants failed", { error: result.error })
							alerts.error(result.error)

							return
						}
					}
				}
			}
		]
	})()

	return (
		<ParticipantList
			title={inSelectionMode ? t("selected", { count: selectedChatParticipants.length }) : t("chat_participants")}
			emptyTitle={t("no_chat_participants")}
			emptyDescription={t("no_chat_participants_description")}
			participants={participants}
			keyExtractor={participant => participant.userId.toString()}
			toRowProps={toRowProps}
			headerLeftItems={headerLeftItems}
			headerRightItems={headerRightItems}
		/>
	)
}

export default ChatParticipants
