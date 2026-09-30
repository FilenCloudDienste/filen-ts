import { useLocalSearchParams } from "expo-router"
import useClearSelectionOnFocusChange from "@/hooks/useClearSelectionOnFocusChange"
import { contactDisplayName } from "@filen/shared"
import { confirmPrompt } from "@/lib/promptFlow"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { type NoteParticipant } from "@/types"
import { type MenuButton } from "@/components/ui/menu"
import { useCachedNote } from "@/features/notes/queries/useNotesQuery"
import notes from "@/features/notes/notes"
import { selectContacts } from "@/features/contacts/contactsSelect"
import DismissStack from "@/components/dismissStack"
import useNoteParticipantsStore from "@/features/notes/store/useNoteParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { useTranslation } from "react-i18next"
import ParticipantList from "@/components/participants/participantList"
import { type ParticipantRowProps } from "@/components/participants/participantRow"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import logger from "@/lib/logger"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"

const clearSelectedNoteParticipants = () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants()

const NoteParticipants = () => {
	const { t } = useTranslation()
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()
	const stringifiedClient = useStringifiedClient()
	const selectedNoteParticipants = useNoteParticipantsStore(useShallow(state => state.selectedNoteParticipants))
	const blocked = useBlockedUsers()

	useClearSelectionOnFocusChange(clearSelectedNoteParticipants)

	const note = useCachedNote(uuid)

	const participants = note ? note.participants.filter(p => p.userId !== stringifiedClient?.userId) : []
	const isOwner = note?.ownerId === stringifiedClient?.userId

	if (!note) {
		return <DismissStack />
	}

	const toRowProps = (participant: NoteParticipant): ParticipantRowProps => {
		const isSelected = selectedNoteParticipants.some(p => p.userId === participant.userId)
		const areOthersSelected = selectedNoteParticipants.length > 0
		const isParticipantBlocked = blocked.userIds.has(participant.userId)

		return {
			email: participant.email,
			displayName: contactDisplayName(participant),
			avatar: participant.avatar,
			permission: isOwner ? (participant.permissionsWrite ? "write" : "read") : undefined,
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
						timestamp: participant.addedTimestamp
					}
				})
			],
			ownerActions: isOwner
				? {
						isSelected,
						areOthersSelected,
						onToggleSelect: () => {
							useNoteParticipantsStore.getState().toggleSelectedNoteParticipant(participant)
						},
						onSetPermission: async permission => {
							const result = await runWithLoading(async () => {
								await notes.setParticipantPermission({
									note,
									participant,
									permissionsWrite: permission === "write"
								})
							})

							if (!result.success) {
								logger.error("notes", "set participant permission failed", {
									error: result.error,
									noteUuid: note.uuid,
									userId: participant.userId
								})
								alerts.error(result.error)

								return
							}
						},
						permissionLabels: {
							title: t("permissions"),
							read: t("permission_read"),
							write: t("permission_write")
						},
						menuActions: [
							{
								id: "remove",
								title: t("remove"),
								destructive: true,
								icon: "delete",
								requiresOnline: true,
								onPress: async () => {
									const confirmed = await confirmPrompt(
										{
											title: t("remove_participant"),
											message: t("remove_participant_confirmation_note"),
											cancelText: t("cancel"),
											okText: t("remove"),
											destructive: true
										},
										{
											tag: "notes",
											message: "remove participant prompt failed",
											level: "error",
											context: {
												noteUuid: note.uuid,
												userId: participant.userId
											}
										}
									)

									if (!confirmed) {
										return
									}

									const result = await runWithLoading(async () => {
										await notes.removeParticipant({
											note,
											participantUserId: participant.userId
										})
									})

									if (!result.success) {
										logger.error("notes", "remove participant failed", {
											error: result.error,
											noteUuid: note.uuid,
											userId: participant.userId
										})
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

	const addParticipants = async () => {
		const selectContactsResult = await selectContacts({
			userIdsToExclude: note.participants.map(p => Number(p.userId))
		})

		if (selectContactsResult.cancelled) {
			return
		}

		const result = await runWithLoading(async () => {
			return await notes.addParticipants({
				note,
				contacts: selectContactsResult.selectedContacts,
				permissionsWrite: true
			})
		})

		if (!result.success) {
			logger.error("notes", "add participants failed", { error: result.error, noteUuid: note.uuid })
			alerts.error(result.error)
		}
	}

	return (
		<ParticipantList
			title={t("note_participants")}
			emptyTitle={t("no_note_participants")}
			emptyDescription={t("no_note_participants_description")}
			participants={participants}
			keyExtractor={participant => participant.userId.toString()}
			toRowProps={toRowProps}
			owner={
				isOwner
					? {
							selectedCount: selectedNoteParticipants.length,
							clearSelection: () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants(),
							selectAll: () => useNoteParticipantsStore.getState().selectAllNoteParticipants(participants),
							bulkButtons: [
								{
									id: "bulkPermissions",
									title: t("permissions"),
									icon: "edit",
									requiresOnline: true,
									subButtons: [
										{
											id: "bulkPermissionRead",
											title: t("permission_read"),
											icon: "eye",
											requiresOnline: true,
											onPress: async () => {
												await runBulk({
													items: selectedNoteParticipants,
													clearSelection: () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants(),
													op: participant =>
														notes.setParticipantPermission({
															note,
															participant,
															permissionsWrite: false
														})
												})
											}
										},
										{
											id: "bulkPermissionWrite",
											title: t("permission_write"),
											icon: "edit",
											requiresOnline: true,
											onPress: async () => {
												await runBulk({
													items: selectedNoteParticipants,
													clearSelection: () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants(),
													op: participant =>
														notes.setParticipantPermission({
															note,
															participant,
															permissionsWrite: true
														})
												})
											}
										}
									]
								},
								{
									id: "bulkRemove",
									title: t("remove_selected"),
									icon: "delete",
									destructive: true,
									requiresOnline: true,
									onPress: async () => {
										await runBulk({
											items: selectedNoteParticipants,
											clearSelection: () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants(),
											confirm: {
												title: t("remove_selected"),
												message: t("remove_selected_participants_confirmation_note"),
												okText: t("remove"),
												cancelText: t("cancel"),
												destructive: true
											},
											op: participant =>
												notes.removeParticipant({
													note,
													participantUserId: participant.userId
												})
										})
									}
								}
							],
							onAdd: addParticipants
						}
					: undefined
			}
		/>
	)
}

export default NoteParticipants
