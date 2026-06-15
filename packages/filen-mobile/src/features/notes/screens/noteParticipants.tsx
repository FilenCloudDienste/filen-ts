import { Platform } from "react-native"
import { useLocalSearchParams, router, useFocusEffect } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import { type HeaderItem } from "@/components/ui/header"
import { useCallback } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import { useStringifiedClient } from "@/lib/auth"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { type NoteParticipant, type Note } from "@/types"
import { type MenuButton } from "@/components/ui/menu"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import notes from "@/features/notes/notes"
import { contactDisplayName } from "@/lib/utils"
import { selectContacts } from "@/features/contacts/contactsSelect"
import DismissStack from "@/components/dismissStack"
import useNoteParticipantsStore from "@/features/notes/store/useNoteParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { useTranslation } from "react-i18next"
import ParticipantList from "@/components/participants/participantList"
import { type ParticipantRowProps } from "@/components/participants/participantRow"
import useIsOnline from "@/hooks/useIsOnline"
import useBlockedUsers from "@/features/contacts/hooks/useBlockedUsers"
import { contactsQueryGet } from "@/features/contacts/queries/useContacts.query"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"

const NoteParticipants = () => {
	const { t } = useTranslation()
	const { note: noteSerialized } = useLocalSearchParams<{
		note?: string
	}>()
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const selectedNoteParticipants = useNoteParticipantsStore(useShallow(state => state.selectedNoteParticipants))
	const isOnline = useIsOnline()
	const blocked = useBlockedUsers()

	useFocusEffect(
		useCallback(() => {
			useNoteParticipantsStore.getState().clearSelectedNoteParticipants()

			return () => {
				useNoteParticipantsStore.getState().clearSelectedNoteParticipants()
			}
		}, [])
	)

	const noteParsed = deserializeRouteParam<Note>(noteSerialized)

	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const note =
		noteParsed && notesWithContentQuery.status === "success"
			? (notesWithContentQuery.data.find(n => n.uuid === noteParsed.uuid) ?? null)
			: null

	const participants = note ? note.participants.filter(p => p.userId !== stringifiedClient?.userId) : []
	const isOwner = note?.ownerId === stringifiedClient?.userId

	if (!note) {
		return <DismissStack />
	}

	const inSelectionMode = isOwner && selectedNoteParticipants.length > 0

	const toRowProps = (participant: NoteParticipant): ParticipantRowProps => {
		const isSelected = selectedNoteParticipants.some(p => p.userId === participant.userId)
		const areOthersSelected = selectedNoteParticipants.length > 0
		const isParticipantBlocked = blocked.userIds.has(participant.userId)
		const blockedUuid = isParticipantBlocked ? contactsQueryGet()?.blocked.find(b => b.userId === participant.userId)?.uuid : undefined

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
					blockedUuid,
					userId: participant.userId,
					email: participant.email,
					avatar: participant.avatar,
					nickName: participant.nickName,
					timestamp: participant.addedTimestamp
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
								console.error(result.error)
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
									const promptResponse = await run(async () => {
										return await prompts.alert({
											title: t("remove_participant"),
											message: t("remove_participant_confirmation_note"),
											cancelText: t("cancel"),
											okText: t("remove"),
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
										await notes.removeParticipant({
											note,
											participantUserId: participant.userId
										})
									})

									if (!result.success) {
										console.error(result.error)
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
							useNoteParticipantsStore.getState().clearSelectedNoteParticipants()
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
					title: selectedNoteParticipants.length === participants.length ? t("deselect_all") : t("select_all"),
					icon: "select",
					onPress: () => {
						if (selectedNoteParticipants.length === participants.length) {
							useNoteParticipantsStore.getState().clearSelectedNoteParticipants()

							return
						}

						useNoteParticipantsStore.getState().selectAllNoteParticipants(participants)
					}
				},
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
							console.error(result.error)
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
			title={inSelectionMode ? t("selected", { count: selectedNoteParticipants.length }) : t("note_participants")}
			emptyTitle={t("no_note_participants")}
			emptyDescription={t("no_note_participants_description")}
			participants={participants}
			keyExtractor={participant => participant.userId.toString()}
			toRowProps={toRowProps}
			headerLeftItems={headerLeftItems}
			headerRightItems={headerRightItems}
		/>
	)
}

export default NoteParticipants
