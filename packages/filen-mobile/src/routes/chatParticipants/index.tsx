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
import { useStringifiedClient } from "@/lib/auth"
import VirtualList from "@/components/ui/virtualList"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { Note, ChatParticipant, Chat } from "@filen/sdk-rs"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Avatar from "@/components/ui/avatar"
import { contactDisplayName } from "@/lib/utils"
import useChatsQuery from "@/queries/useChats.query"
import chats from "@/lib/chats"
import { selectContacts } from "@/routes/contacts"
import DismissStack from "@/components/dismissStack"
import useChatParticipantsStore from "@/stores/useChatParticipants.store"
import { useShallow } from "zustand/shallow"
import { runBulk } from "@/lib/bulkOps"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"

const Participant = memo(({ participant, chat, isOwner }: { participant: ChatParticipant; chat: Chat; isOwner: boolean }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const isSelected = useChatParticipantsStore(
		useShallow(state => state.selectedChatParticipants.some(p => p.userId === participant.userId))
	)
	const areParticipantsSelected = useChatParticipantsStore(useShallow(state => state.selectedChatParticipants.length > 0))

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
							useChatParticipantsStore.getState().toggleSelectedChatParticipant(participant)
						}
					}}
				>
					<View className="flex-row bg-transparent flex-1 gap-2 items-center">
						<View className="flex-row items-center gap-3 bg-transparent">
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
										useChatParticipantsStore.getState().toggleSelectedChatParticipant(participant)
									}
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
											return await chats.removeParticipant({
												chat,
												participant
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

const ChatParticipants = memo(() => {
	const { chat: chatSerialized } = useLocalSearchParams<{
		chat?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()
	const selectedChatParticipants = useChatParticipantsStore(useShallow(state => state.selectedChatParticipants))

	useFocusEffect(
		useCallback(() => {
			useChatParticipantsStore.getState().clearSelectedChatParticipants()

			return () => {
				useChatParticipantsStore.getState().clearSelectedChatParticipants()
			}
		}, [])
	)

	const chatParsed = (() => {
		if (!chatSerialized) {
			return null
		}

		try {
			return deserialize(chatSerialized) as Note
		} catch {
			return null
		}
	})()

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
					title: selectedChatParticipants.length === participants.length ? "tbd_deselect_all" : "tbd_select_all",
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
					title: "tbd_remove_selected",
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedChatParticipants,
							clearSelection: () => useChatParticipantsStore.getState().clearSelectedChatParticipants(),
							confirm: {
								title: "tbd_remove_selected",
								message: "tbd_remove_selected_participants_confirmation",
								okText: "tbd_remove",
								cancelText: "tbd_cancel",
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
				}
			}
		]
	})()

	return (
		<Fragment>
			<Header
				title={inSelectionMode ? `${selectedChatParticipants.length} tbd_selected` : "tbd_chat_participants"}
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
							title="tbd_no_chat_participants"
						/>
					)}
					renderItem={({ item: participant }) => {
						return (
							<Participant
								participant={participant}
								chat={chat}
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

export default ChatParticipants
