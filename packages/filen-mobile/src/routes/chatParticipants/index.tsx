import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
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
import type { Note, ChatParticipant, Chat } from "@filen/sdk-rs"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Avatar from "@/components/ui/avatar"
import { contactDisplayName } from "@/lib/utils"
import useChatsQuery from "@/queries/useChats.query"
import chats from "@/lib/chats"
import { selectContacts } from "@/routes/contacts"
import DismissStack from "@/components/dismissStack"

const Participant = memo(({ participant, chat, isOwner }: { participant: ChatParticipant; chat: Chat; isOwner: boolean }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="flex-row items-center px-4 bg-transparent">
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border">
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
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const insets = useSafeAreaInsets()

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

	return (
		<Fragment>
			<Header
				title="tbd_chat_participants"
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
							chat={chat}
							isOwner={isOwner}
						/>
					)
				}}
				keyExtractor={participant => participant.userId.toString()}
			/>
		</Fragment>
	)
})

export default ChatParticipants
