import { Fragment, memo, useMemo, useCallback } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import { useLocalSearchParams, Redirect, useRouter } from "expo-router"
import useNotesWithContentQuery from "@/queries/useNotesWithContent.query"
import type { Note as TNote, NoteHistory } from "@filen/sdk-rs"
import Content from "@/components/notes/content"
import { Platform } from "react-native"
import useNotesStore from "@/stores/useNotes.store"
import { useShallow } from "zustand/shallow"
import { simpleDate } from "@/lib/time"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import prompts from "@/lib/prompts"
import notes from "@/lib/notes"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { Buffer } from "react-native-quick-crypto"
import { unpack } from "@/lib/msgpack"
import { createMenuButtons } from "@/components/notes/note/menu"
import { useStringifiedClient } from "@/lib/auth"
import useNotesTagsQuery from "@/queries/useNotesTags.query"
import useNoteHistoryQuery from "@/queries/useNoteHistory.query"

const Header = memo(({ note, history }: { note: TNote; history?: NoteHistory | null }) => {
	const isInflight = useNotesStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
	const textForeground = useResolveClassNames("text-foreground")
	const router = useRouter()
	const stringifiedClient = useStringifiedClient()
	const isSelected = useNotesStore(useShallow(state => state.selectedNotes.some(selectedNote => selectedNote.uuid === note.uuid)))
	const isActive = useNotesStore(useShallow(state => state.activeNote?.uuid === note.uuid))

	const writeAccess = useMemo(() => {
		return (
			note.ownerId === stringifiedClient?.userId ||
			note.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)
		)
	}, [note.ownerId, note.participants, stringifiedClient?.userId])

	const isOwner = useMemo(() => {
		return note.ownerId === stringifiedClient?.userId
	}, [note.ownerId, stringifiedClient?.userId])

	const notesTagsQuery = useNotesTagsQuery({
		enabled: false
	})

	const noteHistoryQuery = useNoteHistoryQuery(
		{
			uuid: note.uuid
		},
		{
			enabled: isActive
		}
	)

	const noteHistory = useMemo(() => {
		if (noteHistoryQuery.status !== "success") {
			return []
		}

		return noteHistoryQuery.data.sort((a, b) => Number(b.editedTimestamp) - Number(a.editedTimestamp))
	}, [noteHistoryQuery.data, noteHistoryQuery.status])

	const notesTags = useMemo(() => {
		if (notesTagsQuery.status !== "success") {
			return []
		}

		return notesTagsQuery.data
	}, [notesTagsQuery.data, notesTagsQuery.status])

	const restoreFromHistory = useCallback(async () => {
		if (!history) {
			return
		}

		const result = await run(async () => {
			return await prompts.alert({
				title: "tbd_restore_note",
				message: "tbd_are_you_sure_restore_note",
				cancelText: "tbd_cancel",
				okText: "tbd_drestore"
			})
		})

		if (!result.success) {
			console.error(result.error)
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
			console.error(restoreResult.error)
			alerts.error(restoreResult.error)

			return
		}

		if (router.canGoBack()) {
			router.back()
		}
	}, [history, note, router])

	return (
		<StackHeader
			title={history ? simpleDate(Number(history.editedTimestamp)) : (note.title ?? note.uuid)}
			backVisible={true}
			transparent={Platform.OS === "ios"}
			rightItems={() => {
				if (history) {
					return [
						{
							type: "button",
							props: {
								onPress: restoreFromHistory,
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
									isSelected,
									writeAccess,
									origin: "content",
									noteHistory,
									userId: stringifiedClient?.userId ?? BigInt(0),
									notesTags,
									isOwner
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
})

const Note = memo(() => {
	const { uuid, historyItemPacked } = useLocalSearchParams<{
		uuid: string
		historyItemPacked?: string
	}>()

	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const note = useMemo(() => {
		if (notesWithContentQuery.status !== "success") {
			return null as unknown as TNote
		}

		return notesWithContentQuery.data.find(n => n.uuid === uuid) as TNote
	}, [notesWithContentQuery.data, uuid, notesWithContentQuery.status])

	const history = useMemo(() => {
		return historyItemPacked ? (unpack(Buffer.from(historyItemPacked, "base64")) as NoteHistory) : null
	}, [historyItemPacked])

	if (!(note as TNote | undefined)) {
		return <Redirect href="/tabs/notes" />
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
})

export default Note
