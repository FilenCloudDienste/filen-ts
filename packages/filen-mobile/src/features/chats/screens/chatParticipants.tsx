import { useLocalSearchParams } from "expo-router"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import { useTranslation } from "react-i18next"
import { contactDisplayName } from "@filen/shared"
import { useStringifiedClient } from "@/lib/auth"
import type { ChatParticipant } from "@filen/sdk-rs"
import { type MenuButton } from "@/components/ui/menu"
import useChatsQuery from "@/features/chats/queries/useChats.query"
import chats from "@/features/chats/chats"
import { addChatParticipantsFlow } from "@/features/chats/chatsActions"
import DismissStack from "@/components/dismissStack"
import useChatParticipantsStore from "@/features/chats/store/useChatParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import ParticipantList from "@/components/participants/participantList"
import { type ParticipantRowProps } from "@/components/participants/participantRow"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"
import { confirmedAction } from "@/lib/confirmedAction"

const clearSelectedChatParticipants = () => useChatParticipantsStore.getState().clearSelectedChatParticipants()

const ChatParticipants = () => {
	const { t } = useTranslation()
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()
	const stringifiedClient = useStringifiedClient()
	const selectedChatParticipants = useChatParticipantsStore(useShallow(state => state.selectedChatParticipants))
	const blocked = useBlockedUsers()

	useClearSelectionOnFocusChange(clearSelectedChatParticipants)

	const chatsQuery = useChatsQuery({
		enabled: false
	})

	// Read the DATA (#103): gating on status dismissed this screen whenever the device was offline.
	const chat = uuid ? (chatsQuery.data?.find(n => n.uuid === uuid) ?? null) : null

	const participants = chat ? chat.participants.filter(p => p.userId !== stringifiedClient?.userId) : []
	const isOwner = chat?.ownerId === stringifiedClient?.userId

	if (!chat) {
		return <DismissStack />
	}

	const toRowProps = (participant: ChatParticipant): ParticipantRowProps => {
		const isSelected = selectedChatParticipants.some(p => p.userId === participant.userId)
		const areOthersSelected = selectedChatParticipants.length > 0
		const isParticipantBlocked = blocked.userIds.has(participant.userId)

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
					target: {
						userId: participant.userId,
						email: participant.email,
						avatar: participant.avatar,
						nickName: participant.nickName,
						timestamp: participant.added
					}
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
								onPress: confirmedAction({
									promptTitle: t("remove_participant"),
									promptMessage: t("remove_participant_confirmation"),
									promptOkText: t("remove"),
									action: () =>
										chats.removeParticipant({
											chat,
											participant
										})
								})
							}
						] satisfies MenuButton[]
					}
				: undefined
		}
	}

	return (
		<ParticipantList
			title={t("chat_participants")}
			emptyTitle={t("no_chat_participants")}
			emptyDescription={t("no_chat_participants_description")}
			participants={participants}
			keyExtractor={participant => participant.userId.toString()}
			toRowProps={toRowProps}
			owner={
				isOwner
					? {
							selectedCount: selectedChatParticipants.length,
							clearSelection: () => useChatParticipantsStore.getState().clearSelectedChatParticipants(),
							selectAll: () => useChatParticipantsStore.getState().selectAllChatParticipants(participants),
							bulkButtons: [
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
							],
							onAdd: () => addChatParticipantsFlow(chat)
						}
					: undefined
			}
		/>
	)
}

export default ChatParticipants
