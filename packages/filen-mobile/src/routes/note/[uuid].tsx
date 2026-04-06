import { Fragment, memo } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader from "@/components/ui/header"
import { useLocalSearchParams, Redirect, router } from "expo-router"
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
import { deserialize } from "@/lib/serializer"
import { createMenuButtons } from "@/components/notes/note/menu"
import { useStringifiedClient } from "@/lib/auth"

const Header = memo(({ note, history }: { note: TNote; history?: NoteHistory | null }) => {
	const isInflight = useNotesStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
	const textForeground = useResolveClassNames("text-foreground")
	const stringifiedClient = useStringifiedClient()
	const isSelected = useNotesStore(useShallow(state => state.selectedNotes.some(selectedNote => selectedNote.uuid === note.uuid)))

	const writeAccess =
		note.ownerId === stringifiedClient?.userId ||
		note.participants.some(p => p.userId === stringifiedClient?.userId && p.permissionsWrite)

	const isOwner = note.ownerId === stringifiedClient?.userId

	return (
		<StackHeader
			title={history ? simpleDate(Number(history.editedTimestamp)) : (note.title ?? note.uuid)}
			backVisible={true}
			transparent={Platform.OS === "ios"}
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
									isSelected,
									writeAccess,
									origin: "content",
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
	const { uuid, history: historySerialized } = useLocalSearchParams<{
		uuid: string
		history?: string
	}>()

	const notesWithContentQuery = useNotesWithContentQuery({
		enabled: false
	})

	const note =
		notesWithContentQuery.status === "success"
			? (notesWithContentQuery.data.find(n => n.uuid === uuid) as TNote)
			: (null as unknown as TNote)

	const history = (() => {
		if (!historySerialized) {
			return null
		}

		try {
			return deserialize(historySerialized) as NoteHistory
		} catch {
			return null
		}
	})()

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
