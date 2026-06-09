import { NoteType, type NoteContentEdited } from "@filen/sdk-rs"
import { type Note, type NoteHistory } from "@/types"
import View from "@/components/ui/view"
import useNoteContentQuery from "@/features/notes/queries/useNoteContent.query"
import { notesWithContentQueryGet } from "@/features/notes/queries/useNotesWithContent.query"
import Checklist from "@/features/notes/components/content/checklist"
import { noteTypeToEditorType } from "@/features/notes/utils"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { ActivityIndicator, Text, TouchableOpacity } from "react-native"
import { useResolveClassNames } from "uniwind"
import TextEditor from "@/components/textEditor"
import { useStringifiedClient } from "@/lib/auth"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import useTextEditorStore from "@/stores/useTextEditor.store"
import { useShallow } from "zustand/shallow"
import { useEffect, useCallback } from "react"
import { runEffect, run } from "@filen/utils"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { sync } from "@/features/notes/components/sync"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useIsOnline from "@/hooks/useIsOnline"
import { useTranslation } from "react-i18next"
import { useChecklistHideCompleted } from "@/features/notes/checklistView"

// #38/#13: the blocking loading overlay must show ONLY when there is nothing to render yet AND a
// fetch is genuinely in flight. The per-note query is deliberately disabled while offline or while
// inflight content exists, so `isPending` stays true forever — gating on it alone spins an eternal
// spinner. We therefore require BOTH (no string content yet) AND (fetching or pending). A history
// view is always non-loading. Pure + exported so the standalone test mirrors the live component
// instead of re-implementing a divergent copy of the formula (T5).
export function computeNoteLoading({
	history,
	isFetching,
	isPending,
	initialValue
}: {
	history: boolean
	isFetching: boolean
	isPending: boolean
	initialValue: string | null | undefined
}): boolean {
	if (history) {
		return false
	}

	return typeof initialValue !== "string" && (isFetching || isPending)
}

// #13: a genuine server error renders the error/retry surface, never a blocking spinner. The error
// surface is suppressed for a (read-only) history view.
export function computeNoteFetchError({ history, isError }: { history: boolean; isError: boolean }): boolean {
	return !history && isError
}

const Loading = ({ children, loading, noteType }: { children: React.ReactNode; loading?: boolean; noteType: NoteType }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const textEditorReady = useTextEditorStore(useShallow(state => state.ready))

	const showLoader = noteType === NoteType.Checklist ? loading : loading || !textEditorReady

	return (
		<View className="flex-1">
			{showLoader && (
				<AnimatedView
					// #38 fix: the loading overlay must never intercept touches. Before, the
					// absolute inset-0 overlay sat on top of the editor and (in the inflight
					// case, where content is already rendered behind it) swallowed taps. The
					// spinner is purely informational, so it stays non-interactive.
					pointerEvents="none"
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
}

const Content = ({ note, history }: { note: Note; history?: NoteHistory | null }) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()
	const isOnline = useIsOnline()
	const hasInflightContent = useNotesInflightStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
	// #38 fix: read the freshest unsynced edit reactively so it can SEED the editor
	// (not just gate the query). Selecting the max-timestamp content string keeps
	// this a primitive, so the component only re-renders when the latest in-flight
	// body actually changes.
	const inflightLatest = useNotesInflightStore(
		useShallow(state => {
			const entries = state.inflightContent[note.uuid]

			if (!entries || entries.length === 0) {
				return null
			}

			let latest: (typeof entries)[number] | null = null

			for (const entry of entries) {
				if (!latest || entry.timestamp > latest.timestamp) {
					latest = entry
				}
			}

			return latest ? latest.content : null
		})
	)
	const [hideCompleted] = useChecklistHideCompleted(note.uuid)

	// Gate the query on three conditions to make editing race-free:
	//
	// 1. !history          — history view is read-only, no need to refetch
	// 2. isOnline          — when offline, refetchOnMount:"always" would fire one
	//                        doomed network call per mount (offlineFirst pauses
	//                        after the first failed attempt) and on reconnect
	//                        would race against any local typing
	// 3. !hasInflightContent — the editor's `key` prop is this query's
	//                        dataUpdatedAt, so a successful refetch *remounts*
	//                        the WebView (the underlying expo-dom component
	//                        doesn't propagate initialValue changes any other
	//                        way) and would wipe any unsynced local edits the
	//                        user has in flight. Once sync.tsx drains inflight,
	//                        this re-enables.
	//
	// staleTime: Infinity keeps the query from auto-refetching on the
	// re-enable that follows a sync. Without it, every 3s typing pause would
	// trigger a fetch → loader → editor remount cycle that resets the user's
	// cursor. Initial mount still refetches because refetchOnMount:"always"
	// bypasses the stale check; refetchOnReconnect:"always" bypasses it too
	// when no inflight is in the way. Catch-up for remote edits arrives via
	// the socket → onContentEditedRemotely reload prompt below.
	const noteContentQuery = useNoteContentQuery(
		{
			uuid: note.uuid
		},
		{
			enabled: !history && isOnline && !hasInflightContent,
			staleTime: Infinity
		}
	)

	// #38 fix: seed the editor from the FRESHEST source. The inflight store holds
	// the user's most recent unsynced edit and must win over server/list content so
	// a reseed (or a cold open while edits are queued) never repaints stale
	// pre-edit content. The list query (notesWithContentQueryGet → note.content)
	// is the offline / never-individually-fetched fallback: the note list is
	// persisted to SQLite, so its content is available even when the deliberately
	// disabled per-note query never resolves. Order: history → inflight → server →
	// list fallback.
	const listContent = (() => {
		if (history) {
			return null
		}

		const fromList = notesWithContentQueryGet()?.find(n => n.uuid === note.uuid)

		return fromList ? fromList.content : null
	})()

	const initialValue = history
		? history.content
		: (inflightLatest ?? (noteContentQuery.status === "success" ? noteContentQuery.data : listContent))

	// #38 fix: decouple loading from the deliberately-disabled query. The query is
	// disabled while offline or while inflight content exists (enabled gate below),
	// so it never resolves and `isPending` stays true forever — the old derivation
	// spun an eternal spinner. Now we only show the loader when we have NOTHING to
	// render yet (no inflight, no server, no list content) AND a fetch is genuinely
	// in flight. #13 fix preserved: a genuine server error renders the retry state
	// (see fetchError below), not an eternal blocking spinner.
	const loading = computeNoteLoading({
		history: Boolean(history),
		isFetching: noteContentQuery.isFetching,
		isPending: noteContentQuery.isPending,
		initialValue
	})

	const fetchError = computeNoteFetchError({
		history: Boolean(history),
		isError: noteContentQuery.isError
	})

	const { refetch } = noteContentQuery

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
		// #40 fix (defense-in-depth): never write to the inflight store for a
		// history view or a read-only note. Persisting a read-only edit would push
		// it to sync, where notes.setContent is rejected server-side and never
		// drains the inflight entry — permanently disabling this note's content
		// query (enabled: !hasInflightContent) and wedging future remote edits.
		if (history || !hasWriteAccess) {
			return
		}

		const now = Date.now()

		useNotesInflightStore.getState().setInflightContent(prev => ({
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
			await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)
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
					title: t("note_edited"),
					message: t("note_edited_message"),
					cancelText: t("cancel"),
					okText: t("reload"),
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

			// The user accepted loading the remote edit. Drop any unsynced local
			// content for this note first — otherwise sync.tsx would later push the
			// stale inflight content back to the server, overwriting the remote edit
			// the user just chose to load. Clearing inflight also re-enables the
			// query (enabled gate at line 83) so refetch() can remount the editor
			// with the fresh server content.
			const result = await run(async () => {
				useNotesInflightStore.getState().setInflightContent(prev => {
					const updated = {
						...prev
					}

					delete updated[note.uuid]

					return updated
				})

				await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

				return await refetch()
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		},
		[note.uuid, stringifiedClient, refetch, t]
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

	if (fetchError) {
		return (
			<View className="flex-1 items-center justify-center gap-3 p-6">
				<Text className="text-foreground text-center">{t("error_generic")}</Text>
				<TouchableOpacity
					onPress={() => {
						void refetch()
					}}
				>
					<Text className="text-primary">{t("try_again")}</Text>
				</TouchableOpacity>
			</View>
		)
	}

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
					hideCompleted={hideCompleted}
				/>
			) : (
				<TextEditor
					// Needs a key to reset the editor when the note changes, somehow expo-dom compontents does not update the state properly.
					// #38 fix: this key stays STABLE across the inflight window — while
					// inflight content exists the per-note query is disabled (enabled gate
					// above) so `dataUpdatedAt` never advances, so the editor is not
					// remounted mid-edit. It only changes when a fresh fetch completes
					// (no inflight in the way), which is the intended fresh-content reseed —
					// and `initialValue` now seeds from inflight first, so even that reseed
					// can never repaint stale pre-edit content over in-progress work.
					key={history ? undefined : noteContentQuery.dataUpdatedAt}
					initialValue={initialValue ?? ""}
					onValueChange={onValueChange}
					readOnly={!hasWriteAccess}
					placeholder={t("note_editor_placeholder")}
					type={noteTypeToEditorType(note.noteType)}
					id={`note:${note.uuid}`}
					paddingBottom={insets.bottom}
				/>
			)}
		</Loading>
	)
}

export default Content
