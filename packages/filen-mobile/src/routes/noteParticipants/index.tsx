import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useLocalSearchParams, router, useFocusEffect } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo, useCallback } from "react"
import { useResolveClassNames } from "uniwind"
import { run, cn } from "@filen/utils"
import prompts from "@/lib/prompts"
import { useStringifiedClient } from "@/lib/auth"
import VirtualList from "@/components/ui/virtualList"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import Ionicons from "@expo/vector-icons/Ionicons"
import { type NoteParticipant, type Note } from "@/types"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import notes from "@/lib/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Avatar from "@/components/ui/avatar"
import { contactDisplayName } from "@/lib/utils"
import { selectContacts } from "@/routes/contacts"
import DismissStack from "@/components/dismissStack"
import useNoteParticipantsStore from "@/stores/useNoteParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"

const Participant = memo(({ participant, note, isOwner }: { participant: NoteParticipant; note: Note; isOwner: boolean }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const isSelected = useNoteParticipantsStore(
		useShallow(state => state.selectedNoteParticipants.some(p => p.userId === participant.userId))
	)
	const areParticipantsSelected = useNoteParticipantsStore(useShallow(state => state.selectedNoteParticipants.length > 0))

	return (
		<View className={cn("flex-row items-center px-4 bg-transparent", isSelected && "bg-background-tertiary")}>
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border flex-1">
				{isOwner && areParticipantsSelected && (
					<AnimatedView
						className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
						entering={FadeIn}
						exiting={FadeOut}
					>
						<Checkbox value={isSelected} />
					</AnimatedView>
				)}
				<PressableScale
					className="flex-row bg-transparent flex-1"
					onPress={() => {
						if (isOwner && areParticipantsSelected) {
							useNoteParticipantsStore.getState().toggleSelectedNoteParticipant(participant)
						}
					}}
				>
					<View className="flex-row bg-transparent flex-1 gap-2 items-center">
					<View className="flex-row items-center gap-3 bg-transparent">
						{isOwner ? (
							participant.permissionsWrite ? (
								<Ionicons
									name="pencil-outline"
									size={16}
									color={textMutedForeground.color}
								/>
							) : (
								<Ionicons
									name="eye-outline"
									size={16}
									color={textMutedForeground.color}
								/>
							)
						) : null}
						<Avatar
							className="shrink-0"
							size={32}
							source={participant.avatar}
						/>
					</View>
					<View className="flex-col bg-transparent gap-0.5 flex-1">
						<Text
							className="text-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{contactDisplayName(participant)}
						</Text>
						<Text
							className="text-muted-foreground text-xs"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{participant.email}
						</Text>
					</View>
					</View>
				</PressableScale>
				{isOwner && (
					<View className="flex-row items-center gap-4 bg-transparent">
						<Menu
							type="dropdown"
							buttons={[
								{
									id: "select",
									title: isSelected ? "tbd_deselect" : "tbd_select",
									icon: "select",
									checked: isSelected,
									onPress: () => {
										useNoteParticipantsStore.getState().toggleSelectedNoteParticipant(participant)
									}
								},
								{
									id: "permissions",
									title: "tbd_permissions",
									icon: participant.permissionsWrite ? "edit" : "eye",
									subButtons: [
										{
											id: "read",
											title: "tbd_read",
											icon: "eye",
											checked: !participant.permissionsWrite,
											requiresOnline: true,
											onPress: async () => {
												const result = await runWithLoading(async () => {
													await notes.setParticipantPermission({
														note,
														participant,
														permissionsWrite: false
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
											id: "write",
											title: "tbd_write",
											icon: "edit",
											checked: participant.permissionsWrite,
											requiresOnline: true,
											onPress: async () => {
												const result = await runWithLoading(async () => {
													await notes.setParticipantPermission({
														note,
														participant,
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
									]
								},
								{
									id: "remove",
									title: "tbd_remove",
									destructive: true,
									icon: "delete",
									requiresOnline: true,
									onPress: async () => {
										const promptResponse = await run(async () => {
											return await prompts.alert({
												title: "tbd_remove_participant",
												message: "tbd_remove_participant_confirmation",
												cancelText: "tbd_cancel",
												okText: "tbd_remove",
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
							]}
						>
							<CrossGlassContainerView>
								<PressableScale className="size-9 items-center justify-center">
									<Ionicons
										name="ellipsis-horizontal"
										size={20}
										color={textForeground.color}
									/>
								</PressableScale>
							</CrossGlassContainerView>
						</Menu>
					</View>
				)}
			</View>
		</View>
	)
})

const NoteParticipants = memo(() => {
	const { note: noteSerialized } = useLocalSearchParams<{
		note?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()
	const selectedNoteParticipants = useNoteParticipantsStore(useShallow(state => state.selectedNoteParticipants))

	useFocusEffect(
		useCallback(() => {
			useNoteParticipantsStore.getState().clearSelectedNoteParticipants()

			return () => {
				useNoteParticipantsStore.getState().clearSelectedNoteParticipants()
			}
		}, [])
	)

	const noteParsed = (() => {
		if (!noteSerialized) {
			return null
		}

		try {
			return deserialize(noteSerialized) as Note
		} catch {
			return null
		}
	})()

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

	const leftItems: HeaderItem[] = (() => {
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
						name: "chevron-back-outline",
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

	const rightItems: HeaderItem[] | undefined = (() => {
		if (inSelectionMode) {
			const menuButtons: MenuButton[] = [
				{
					id: "selectAll",
					title: selectedNoteParticipants.length === participants.length ? "tbd_deselect_all" : "tbd_select_all",
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
					title: "tbd_permissions",
					icon: "edit",
					requiresOnline: true,
					subButtons: [
						{
							id: "bulkPermissionRead",
							title: "tbd_read",
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
							title: "tbd_write",
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
					title: "tbd_remove_selected",
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedNoteParticipants,
							clearSelection: () => useNoteParticipantsStore.getState().clearSelectedNoteParticipants(),
							confirm: {
								title: "tbd_remove_selected",
								message: "tbd_remove_selected_participants_confirmation",
								okText: "tbd_remove",
								cancelText: "tbd_cancel",
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
					onPress: async () => {
						const selectContactsResult = await selectContacts({
							multiple: true,
							userIdsToExclude: note.participants.map(p => Number(p.userId))
						})

						if (selectContactsResult.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							return await Promise.all(
								selectContactsResult.selectedContacts.map(async contact => {
									return await notes.addParticipant({
										note,
										contact,
										permissionsWrite: true
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
				}
			}
		]
	})()

	return (
		<Fragment>
			<Header
				title={inSelectionMode ? `${selectedNoteParticipants.length} tbd_selected` : "tbd_note_participants"}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={leftItems}
				rightItems={rightItems}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={participants}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="people-outline"
							title="tbd_no_note_participants"
						/>
					)}
					renderItem={({ item: participant }) => {
						return (
							<Participant
								participant={participant}
								note={note}
								isOwner={isOwner}
							/>
						)
					}}
					keyExtractor={participant => participant.userId.toString()}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default NoteParticipants
