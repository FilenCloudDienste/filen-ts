import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize, serialize } from "@/lib/serializer"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { NoteHistory as TNoteHistory, Note } from "@filen/sdk-rs"
import Menu from "@/components/ui/menu"
import { PressableScale } from "@/components/ui/pressables"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import useNoteHistoryQuery from "@/queries/useNoteHistory.query"
import notes from "@/lib/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Icon from "@/components/notes/note/icon"
import DismissStack from "@/components/dismissStack"

const History = memo(({ history, note }: { history: TNoteHistory; note: Note }) => {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="flex-row items-center px-4 bg-transparent">
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border">
				<View className="flex-row items-center justify-center p-1 rounded-full border border-border size-8 bg-background-tertiary">
					<Icon
						note={{
							...note,
							trash: false,
							archive: false,
							noteType: history.noteType
						}}
						iconSize={18}
					/>
				</View>
				<View className="flex-col bg-transparent flex-1 gap-0.5">
					<Text
						className="text-foreground"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{simpleDate(Number(history.editedTimestamp))}
					</Text>
					<Text
						className="text-muted-foreground text-xs"
						numberOfLines={1}
						ellipsizeMode="tail"
					>
						{history.preview ?? "tbd_no_preview"}
					</Text>
				</View>
				<View className="flex-row items-center gap-2 bg-transparent">
					<Menu
						type="dropdown"
						buttons={[
							{
								id: "view",
								title: "tbd_view",
								onPress: () => {
									router.push({
										pathname: "/note/[uuid]",
										params: {
											uuid: note.uuid,
											history: serialize(history)
										}
									})
								}
							},
							{
								id: "restore",
								title: "tbd_restore",
								onPress: async () => {
									const promptResponse = await run(async () => {
										return await prompts.alert({
											title: "tbd_restore_history",
											message: "tbd_restore_history_confirmation",
											cancelText: "tbd_cancel",
											okText: "tbd_restore",
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
										await notes.restoreFromHistory({
											note,
											history
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
			</View>
		</View>
	)
})

const NoteHistory = memo(() => {
	const { note: noteSerialized } = useLocalSearchParams<{
		note?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
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

	const noteHistoryQuery = useNoteHistoryQuery(
		{
			uuid: note?.uuid ?? ""
		},
		{
			enabled: !!note
		}
	)

	const history = noteHistoryQuery.status === "success" && note ? noteHistoryQuery.data : []

	if (!note) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<Header
				title="tbd_note_history"
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
					],
					default: undefined
				})}
			/>
			<VirtualList
				data={history}
				loading={noteHistoryQuery.status !== "success"}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{
					paddingBottom: insets.bottom
				}}
				onRefresh={async () => {
					const result = await run(async () => {
						return await noteHistoryQuery.refetch()
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}}
				emptyComponent={() => {
					return (
						<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
							<Ionicons
								name="time-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text>tbd_no_note_history</Text>
						</View>
					)
				}}
				renderItem={({ item: history }) => {
					return (
						<History
							history={history}
							note={note}
						/>
					)
				}}
				keyExtractor={history => history.id.toString()}
			/>
		</Fragment>
	)
})

export default NoteHistory
