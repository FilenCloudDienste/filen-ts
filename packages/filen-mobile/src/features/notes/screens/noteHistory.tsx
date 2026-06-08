import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import { Platform } from "react-native"
import { onlineManager } from "@tanstack/react-query"
import { useLocalSearchParams, router, useNavigation } from "expo-router"
import { deserializeRouteParam, serialize } from "@/lib/serializer"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header from "@/components/ui/header"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { type NoteHistory as TNoteHistory, type Note } from "@/types"
import Menu from "@/components/ui/menu"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import useNoteHistoryQuery from "@/features/notes/queries/useNoteHistory.query"
import notes from "@/features/notes/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Icon from "@/features/notes/components/note/icon"
import DismissStack from "@/components/dismissStack"
import { useTranslation } from "react-i18next"
import ListRow from "@/components/ui/listRow"

const History = ({ history, note }: { history: TNoteHistory; note: Note }) => {
	const { t } = useTranslation()

	return (
		<ListRow
			separator={true}
			leading={
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
			}
			title={simpleDate(Number(history.editedTimestamp))}
			subtitle={history.preview ?? t("no_preview_history")}
			subtitleEllipsizeMode="tail"
			trailing={
				<Menu
					type="dropdown"
					buttons={[
						{
							id: "view",
							title: t("view"),
							icon: "eye",
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
							title: t("restore"),
							icon: "restore",
							requiresOnline: true,
							onPress: async () => {
								const promptResponse = await run(async () => {
									return await prompts.alert({
										title: t("restore_history"),
										message: t("restore_history_confirmation"),
										cancelText: t("cancel"),
										okText: t("restore"),
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
					<EllipsisMenuTrigger />
				</Menu>
			}
		/>
	)
}

const NoteHistory = () => {
	const { t } = useTranslation()
	const { note: noteSerialized } = useLocalSearchParams<{
		note?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()

	const noteParsed = deserializeRouteParam<Note>(noteSerialized)

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
				title={t("note_history")}
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
									navigation.getParent()?.goBack()
								}
							}
						}
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={history}
					loading={noteHistoryQuery.status !== "success"}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					onRefresh={async () => {
						if (!onlineManager.isOnline()) {
							return
						}

						const result = await run(async () => {
							return await noteHistoryQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="time-outline"
							title={t("no_note_history")}
						/>
					)}
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
			</SafeAreaView>
		</Fragment>
	)
}

export default NoteHistory
