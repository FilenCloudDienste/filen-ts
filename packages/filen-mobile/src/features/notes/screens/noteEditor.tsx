import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import { useLocalSearchParams, useNavigation } from "expo-router"
import { router } from "@/lib/router"
import useNotesWithContentQuery from "@/features/notes/queries/useNotesWithContent.query"
import { type Note as TNote, type NoteHistory } from "@/types"
import { noteDisplayTitle } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import Content from "@/features/notes/components/content"
import { Platform } from "react-native"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import { useShallow } from "zustand/shallow"
import { simpleDate } from "@/lib/time"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import prompts from "@/lib/prompts"
import notes from "@/features/notes/notes"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { deserializeRouteParam } from "@/lib/serializer"
import { createMenuButtons } from "@/features/notes/components/note/menu"
import { useChecklistHideCompleted } from "@/features/notes/checklistView"
import { useStringifiedClient } from "@/lib/auth"
import DismissStack from "@/components/dismissStack"
import { useKeyboardState } from "react-native-keyboard-controller"
import { NoteType } from "@filen/sdk-rs"
import useTextEditorStore from "@/stores/useTextEditor.store"
import { RichTextHeaderToolbar } from "@/components/textEditor/richText/toolbar"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

const Header = ({ note, history }: { note: TNote; history?: NoteHistory | null }) => {
	const { t } = useTranslation()
	const isInflight = useNotesInflightStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const navigation = useNavigation()
	const keyboardState = useKeyboardState()
	const dispatch = useTextEditorStore(state => state.dispatch)
	const [hideCompletedChecklistItems, toggleHideCompletedChecklistItems] = useChecklistHideCompleted(note.uuid)

	const writeAccess =
		note.ownerId === stringifiedClient?.userId ||
		note.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)

	const isOwner = note.ownerId === stringifiedClient?.userId

	// Swap the header title for the rich-text toolbar while the user is
	// typing. Gated on:
	//   - keyboard visible (so we don't steal title space when not editing)
	//   - !history (history is read-only — no edits possible)
	//   - noteType is Rich (text/markdown/code/checklist use other UI)
	//   - dispatch is non-null (TextEditor is mounted and reachable)
	const showToolbar = keyboardState.isVisible && !history && note.noteType === NoteType.Rich && dispatch !== null

	return (
		<StackHeader
			title={
				showToolbar && dispatch
					? () => <RichTextHeaderToolbar dispatch={dispatch} />
					: history
						? simpleDate(Number(history.editedTimestamp))
						: noteDisplayTitle(note)
			}
			backVisible={true}
			shadowVisible={false}
			transparent={Platform.OS === "ios"}
			leftItems={Platform.select({
				ios: [
					{
						type: "button",
						icon: {
							// /note/[uuid] is reached two ways:
							//   - from /tabs/notes — push onto the tab's stack. Tapping the left
							//     button should pop back to the list (chevron-back-outline).
							//   - from /noteHistory (a modal) — when the user taps a history
							//     entry, the same route renders with the `history` param set,
							//     stacking on top of the history modal. Tapping the left button
							//     dismisses back to history (close).
							name: history ? "close" : "chevron-back-outline",
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
			rightItems={() => {
				if (history) {
					return [
						{
							type: "button",
							props: {
								onPress: async () => {
									if (!history) {
										return
									}

									const result = await run(async () => {
										return await prompts.alert({
											title: t("restore_note"),
											message: t("are_you_sure_restore_note"),
											cancelText: t("cancel"),
											okText: t("restore"),
											destructive: true
										})
									})

									if (!result.success) {
										logger.error("notes", "restore from history prompt failed", { error: result.error, noteUuid: note.uuid })
										alerts.error(result.error)

										return
									}

									if (result.data.cancelled) {
										return
									}

									const restoreResult = await runWithLoading(async () => {
										return await notes.restoreFromHistory({
											note,
											history
										})
									})

									if (!restoreResult.success) {
										logger.error("notes", "restore from history failed", { error: restoreResult.error, noteUuid: note.uuid })
										alerts.error(restoreResult.error)

										return
									}

									if (router.canGoBack()) {
										router.back()
									}
								},
								hitSlop: 32
							},
							icon: {
								name: "refresh",
								size: 24,
								color: textForeground.color
							}
						}
					]
				}

				if (!isInflight) {
					return [
						{
							type: "menu",
							props: {
								type: "dropdown",
								hitSlop: 20,
								buttons: createMenuButtons({
									note,
									writeAccess,
									origin: "content",
									isOwner,
									hideCompletedChecklistItems,
									onToggleHideCompletedChecklistItems: toggleHideCompletedChecklistItems
								})
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

				return [
					{
						type: "loader",
						props: {
							color: textForeground.color,
							size: "small"
						}
					}
				]
			}}
		/>
	)
}

const Note = () => {
	const { uuid, history: historySerialized } = useLocalSearchParams<{
		uuid: string
		history?: string
	}>()

	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const note = notesWithContentQuery.status === "success" ? (notesWithContentQuery.data.find(n => n.uuid === uuid) ?? null) : null

	const history = deserializeRouteParam<NoteHistory>(historySerialized)

	if (!note) {
		return <DismissStack />
	}

	if (note.undecryptable) {
		return (
			<Fragment>
				<Header
					note={note}
					history={history}
				/>
				<SafeAreaView edges={["left", "right"]}>
					<CannotDecryptScreen
						uuid={note.uuid}
						surface="note"
					/>
				</SafeAreaView>
			</Fragment>
		)
	}

	return (
		<Fragment>
			<Header
				note={note}
				history={history}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<Content
					note={note}
					history={history ?? undefined}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Note
