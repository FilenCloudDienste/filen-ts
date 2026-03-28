import { type Note, NoteType, type NoteHistory, type NoteContentEdited } from "@filen/sdk-rs"
import View from "@/components/ui/view"
import useNoteContentQuery from "@/queries/useNoteContent.query"
import Checklist from "@/components/notes/content/checklist"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { ActivityIndicator } from "react-native"
import { useResolveClassNames } from "uniwind"
import TextEditor from "@/components/textEditor"
import { useStringifiedClient } from "@/lib/auth"
import useNotesStore from "@/stores/useNotes.store"
import useTextEditorStore from "@/stores/useTextEditor.store"
import { useShallow } from "zustand/shallow"
import { useEffect, memo, useCallback } from "react"
import { runEffect, run } from "@filen/utils"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { sync } from "@/components/notes/sync"
import { useSafeAreaInsets } from "react-native-safe-area-context"

const Loading = memo(({ children, loading, noteType }: { children: React.ReactNode; loading?: boolean; noteType: NoteType }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textEditorReady = useTextEditorStore(useShallow(state => state.ready))

	const showLoader = noteType === NoteType.Checklist ? loading : loading || !textEditorReady

	return (
		<View className="flex-1">
			{showLoader && (
				<AnimatedView
					className="absolute inset-0 z-9999 flex-1 items-center justify-center bg-background/50"
					exiting={FadeOut}
				>
					<ActivityIndicator
						size="large"
						color={textForeground.color as string}
					/>
				</AnimatedView>
			)}
			{children}
		</View>
	)
})

const Content = memo(({ note, history }: { note: Note; history?: NoteHistory | null }) => {
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()

	const noteContentQuery = useNoteContentQuery(
		{
			uuid: note.uuid
		},
		{
			enabled: !history
		}
	)

	const initialValue = history ? history.content : noteContentQuery.status === "success" ? noteContentQuery.data : null

	const loading = history
		? false
		: noteContentQuery.isRefetching ||
			noteContentQuery.isLoading ||
			noteContentQuery.isFetching ||
			noteContentQuery.isPending ||
			noteContentQuery.isError ||
			noteContentQuery.isRefetchError ||
			noteContentQuery.isLoadingError ||
			typeof initialValue !== "string"

	const hasWriteAccess = (() => {
		if (!stringifiedClient || history) {
			return false
		}

		return (
			note.ownerId === stringifiedClient.userId ||
			note.participants.some(participant => participant.userId === stringifiedClient.userId && participant.permissionsWrite)
		)
	})()

	const onValueChange = async (value: string) => {
		if (history) {
			return
		}

		const now = Date.now()

		useNotesStore.getState().setInflightContent(prev => ({
			...prev,
			[note.uuid]: [
				{
					timestamp: now,
					note,
					content: value
				},
				...(prev[note.uuid] ?? []).filter(c => c.timestamp > now)
			]
		}))

		const result = await run(async () => {
			await sync.flushToDisk(useNotesStore.getState().inflightContent)
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)

			return
		}

		sync.syncDebounced()
	}

	const onContentEditedRemotely = useCallback(
		async (info: { contentEdited: NoteContentEdited; noteUuid: string }) => {
			if (note.uuid !== info.noteUuid || info.contentEdited.editorId === stringifiedClient?.userId) {
				return
			}

			const promptResponse = await run(async () => {
				return await prompts.alert({
					title: "tbd_note_edited",
					message: "tbd_note_edited_message",
					cancelText: "tbd_cancel",
					okText: "tbd_reload"
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

			const result = await run(async () => {
				return await noteContentQuery.refetch()
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		},
		[note.uuid, stringifiedClient, noteContentQuery]
	)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const noteContentEditedSubscription = events.subscribe("noteContentEdited", onContentEditedRemotely)

			defer(() => {
				noteContentEditedSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [note.uuid, onContentEditedRemotely])

	return (
		<Loading
			loading={loading}
			noteType={note.noteType}
		>
			{note.noteType === NoteType.Checklist ? (
				<Checklist
					initialValue={initialValue ?? ""}
					onChange={onValueChange}
					readOnly={!hasWriteAccess}
				/>
			) : (
				<TextEditor
					// Needs a key to reset the editor when the note changes, somehow expo-dom compontents does not update the state properly
					key={history ? undefined : noteContentQuery.dataUpdatedAt}
					initialValue={initialValue ?? ""}
					onValueChange={onValueChange}
					readOnly={!hasWriteAccess}
					placeholder="tbd_placeholder"
					type={
						note.noteType === NoteType.Text
							? "text"
							: note.noteType === NoteType.Code
								? "code"
								: note.noteType === NoteType.Md
									? "markdown"
									: note.noteType === NoteType.Rich
										? "richtext"
										: "text"
					}
					id={`note:${note.uuid}`}
					paddingBottom={insets.bottom}
				/>
			)}
		</Loading>
	)
})

export default Content
