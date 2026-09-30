import { Fragment } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import { useLocalSearchParams } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"
import useNotesQuery from "@/features/notes/queries/useNotesQuery"
import { type Note as TNote, type NoteHistory } from "@/types"
import { noteDisplayTitle } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import Content from "@/features/notes/components/content"
import { Platform } from "react-native"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import useNotesOfflineStore from "@/features/notes/store/useNotesOffline.store"
import { useShallow } from "zustand/shallow"
import { simpleDate } from "@/lib/time"
import { useResolveClassNames } from "uniwind"
import { confirmedAction } from "@/lib/confirmedAction"
import notes from "@/features/notes/notes"
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
import Text from "@/components/ui/text"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import Ionicons from "@expo/vector-icons/Ionicons"

// Header-middle title for a note shared to us without write access: the note title (kept for identity)
// with a compact "View only" chip beneath it, so the reason the editor is non-editable is visible right
// where the rich-text toolbar would otherwise sit. Read-only notes never show that toolbar, so the two
// never collide.
const ReadOnlyTitle = ({ title }: { title: string }) => {
	const { t } = useTranslation()
	const textMuted = useResolveClassNames("text-muted-foreground")

	return (
		<View className="items-center justify-center gap-px bg-transparent">
			<Text
				numberOfLines={1}
				ellipsizeMode="middle"
				className="text-[17px] font-semibold text-foreground leading-6"
			>
				{title}
			</Text>
			<CrossGlassContainerView className="flex-row items-center gap-1 px-2 py-0.5 overflow-hidden">
				<Ionicons
					name="eye-outline"
					size={11}
					color={textMuted.color}
				/>
				<Text className="text-xs text-muted-foreground leading-4">{t("note_view_only")}</Text>
			</CrossGlassContainerView>
		</View>
	)
}

const Header = ({ note, history }: { note: TNote; history?: NoteHistory | null }) => {
	const { t } = useTranslation()
	const isInflight = useNotesInflightStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
	const isAvailableOffline = useNotesOfflineStore(state => state.marked[note.uuid] === true)
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const dismiss = useDismissStack()
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
						: !writeAccess
							? () => <ReadOnlyTitle title={noteDisplayTitle(note)} />
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
								dismiss()
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
								onPress: confirmedAction({
									promptTitle: t("restore_note"),
									promptMessage: t("are_you_sure_restore_note"),
									promptOkText: t("restore"),
									action: () => notes.restoreFromHistory({ note, history }),
									dismiss: () => true
								}),
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
							type: "ellipsisMenu",
							buttons: createMenuButtons({
								note,
								writeAccess,
								origin: "content",
								isOwner,
								isAvailableOffline,
								hideCompletedChecklistItems,
								onToggleHideCompletedChecklistItems: toggleHideCompletedChecklistItems
							})
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

	const notesQuery = useNotesQuery({
		enabled: false
	})

	// A failed refetch keeps the data and only flips `status` (#103) — resolve from the cached
	// list so an offline note still opens.
	const note = notesQuery.data?.find(n => n.uuid === uuid) ?? null

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
					<CannotDecryptScreen uuid={note.uuid} />
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
