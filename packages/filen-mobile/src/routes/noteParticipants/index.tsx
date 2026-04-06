import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useLocalSearchParams, Redirect, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import { useStringifiedClient } from "@/lib/auth"
import VirtualList from "@/components/ui/virtualList"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { NoteParticipant, Note } from "@filen/sdk-rs"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import notes from "@/lib/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Avatar from "@/components/ui/avatar"
import { contactDisplayName } from "@/lib/utils"
import { selectContacts } from "@/routes/contacts"

const Participant = memo(({ participant, note, isOwner }: { participant: NoteParticipant; note: Note; isOwner: boolean }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className="flex-row items-center px-4 bg-transparent">
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border">
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
				{isOwner && (
					<View className="flex-row items-center gap-4 bg-transparent">
						<Menu
							type="dropdown"
							buttons={[
								{
									id: "remove",
									title: "tbd_remove",
									destructive: true,
									icon: "delete",
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
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const insets = useSafeAreaInsets()

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
		return (
			<Redirect
				href={{
					pathname: "/tabs/drive/[uuid]",
					params: {
						uuid: stringifiedClient?.rootUuid ?? "root"
					}
				}}
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title="tbd_note_participants"
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
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
					] satisfies HeaderItem[],
					default: undefined
				})}
				rightItems={
					isOwner
						? ([
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
							] satisfies HeaderItem[])
						: undefined
				}
			/>
			<VirtualList
				data={participants}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{
					paddingBottom: insets.bottom
				}}
				emptyComponent={() => {
					return (
						<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
							<Ionicons
								name="people-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text>tbd_no_note_participants</Text>
						</View>
					)
				}}
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
		</Fragment>
	)
})

export default NoteParticipants
