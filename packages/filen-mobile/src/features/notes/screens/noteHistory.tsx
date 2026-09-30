import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import { useLocalSearchParams } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"
import { router } from "@/lib/router"
import { serialize } from "@/lib/serializer"
import View from "@/components/ui/view"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty, { LoadErrorEmpty } from "@/components/ui/listEmpty"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
import { run, sortNoteHistory } from "@filen/shared"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import alerts from "@/lib/alerts"
import { confirmedAction } from "@/lib/confirmedAction"
import { type NoteHistory as TNoteHistory, type Note } from "@/types"
import Menu from "@/components/ui/menu"
import { useCachedNote } from "@/features/notes/queries/useNotesQuery"
import useNoteHistoryQuery from "@/features/notes/queries/useNoteHistory.query"
import notes from "@/features/notes/notes"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Icon from "@/features/notes/components/note/icon"
import DismissStack from "@/components/dismissStack"
import { useTranslation } from "react-i18next"
import ListRow from "@/components/ui/listRow"
import logger from "@/lib/logger"

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
							onPress: confirmedAction({
								promptTitle: t("restore_history"),
								promptMessage: t("are_you_sure_restore_note"),
								promptOkText: t("restore"),
								action: () => notes.restoreFromHistory({ note, history })
							})
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
	const { uuid } = useLocalSearchParams<{
		uuid?: string
	}>()
	const insets = useSafeAreaInsets()
	const dismiss = useDismissStack()

	const note = useCachedNote(uuid)

	const noteHistoryQuery = useNoteHistoryQuery(
		{
			uuid: note?.uuid ?? ""
		},
		{
			enabled: !!note
		}
	)

	// A failed refetch keeps the data and only flips `status` (#103).
	const history = noteHistoryQuery.data && note ? sortNoteHistory(noteHistoryQuery.data) : []

	const historyEmptyComponent = () => {
		if (noteHistoryQuery.status === "error") {
			return (
				<LoadErrorEmpty
					title={t("note_history_error")}
					retryLabel={t("reload")}
					onRetry={() => {
						void noteHistoryQuery.refetch()
					}}
				/>
			)
		}

		return (
			<ListEmpty
				icon="time-outline"
				title={t("no_note_history")}
				description={t("no_note_history_description")}
			/>
		)
	}

	if (!note) {
		return <DismissStack />
	}

	return (
		<Fragment>
			<SettingsHeader
				title={t("note_history")}
				icon="close"
				onDismiss={dismiss}
			/>
			<ScreenBody>
				<VirtualList
					data={history}
					loading={noteHistoryQuery.status === "pending"}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					requiresOnline={true}
					onRefresh={async () => {
						const result = await run(async () => {
							return await noteHistoryQuery.refetch()
						})

						if (!result.success) {
							logger.error("notes", "note history refresh failed", { error: result.error })
							alerts.error(result.error)
						}
					}}
					emptyComponent={historyEmptyComponent}
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
			</ScreenBody>
		</Fragment>
	)
}

export default NoteHistory
