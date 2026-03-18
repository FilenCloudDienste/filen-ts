import { memo, useMemo, useCallback } from "@/lib/memo"
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
import isEqual from "react-fast-compare"
import { useEffect } from "react"
import { runEffect, run } from "@filen/utils"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { sync } from "@/components/notes/sync"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export const Loading = memo(({ children, loading, noteType }: { children: React.ReactNode; loading?: boolean; noteType: NoteType }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textEditorReady = useTextEditorStore(useShallow(state => state.ready))

	const showLoader = useMemo(() => {
		if (noteType === NoteType.Checklist) {
			return loading
		}

		return loading || !textEditorReady
	}, [loading, textEditorReady, noteType])

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

export const Content = memo(
	({ note, history }: { note: Note; history?: NoteHistory | null }) => {
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

		const initialValue = useMemo(() => {
			if (history) {
				return history.content
			}

			if (noteContentQuery.status !== "success") {
				return null
			}

			return noteContentQuery.data
		}, [noteContentQuery.data, noteContentQuery.status, history])

		const loading = useMemo(() => {
			if (history) {
				return false
			}

			return (
				noteContentQuery.isRefetching ||
				noteContentQuery.isLoading ||
				noteContentQuery.isFetching ||
				noteContentQuery.isPending ||
				noteContentQuery.isError ||
				noteContentQuery.isRefetchError ||
				noteContentQuery.isLoadingError ||
				typeof initialValue !== "string"
			)
		}, [
			noteContentQuery.isError,
			noteContentQuery.isFetching,
			noteContentQuery.isLoading,
			noteContentQuery.isLoadingError,
			noteContentQuery.isPending,
			noteContentQuery.isRefetchError,
			noteContentQuery.isRefetching,
			initialValue,
			history
		])

		const hasWriteAccess = useMemo(() => {
			if (!stringifiedClient || history) {
				return false
			}

			return (
				note.ownerId === stringifiedClient.userId ||
				note.participants.some(participant => participant.userId === stringifiedClient.userId && participant.permissionsWrite)
			)
		}, [stringifiedClient, note, history])

		const onValueChange = useCallback(
			async (value: string) => {
				if (history) {
					return
				}

				const now = Date.now()
				let didFlushToDisk = false
				let flushToDiskError: Error | null = null

				useNotesStore.getState().setInflightContent(prev => {
					const updated = {
						...prev,
						[note.uuid]: [
							{
								timestamp: now,
								note,
								content: value
							},
							...(prev[note.uuid] ?? []).filter(c => c.timestamp > now)
						]
					}

					sync.flushToDisk(updated)
						.then(() => {
							didFlushToDisk = true

							sync.syncDebounced()
						})
						.catch(err => {
							flushToDiskError = err
						})

					return updated
				})

				const result = await run(async () => {
					while (!didFlushToDisk) {
						if (flushToDiskError) {
							throw flushToDiskError
						}

						await new Promise<void>(resolve => setTimeout(resolve, 100))
					}
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			},
			[note, history]
		)

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
	},
	{
		propsAreEqual(prevProps, nextProps) {
			return (
				prevProps.note.uuid === nextProps.note.uuid &&
				isEqual(prevProps.note.participants, nextProps.note.participants) &&
				prevProps.note.ownerId === nextProps.note.ownerId &&
				prevProps.note.noteType === nextProps.note.noteType
			)
		}
	}
)

export default Content
