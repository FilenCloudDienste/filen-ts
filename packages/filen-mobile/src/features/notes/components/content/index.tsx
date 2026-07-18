import { NoteType, type NoteContentEdited } from "@filen/sdk-rs"
import { type Note, type NoteHistory } from "@/types"
import View from "@/components/ui/view"
import useNoteContentQuery, { noteContentQueryGet } from "@/features/notes/queries/useNoteContent.query"
import Checklist from "@/features/notes/components/content/checklist"
import { noteTypeToEditorType } from "@/features/notes/utils"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { ActivityIndicator } from "react-native"
import { useResolveClassNames } from "uniwind"
import TextEditor from "@/components/textEditor"
import { useStringifiedClient } from "@/lib/auth"
import useNotesInflightStore, { type InflightContent } from "@/features/notes/store/useNotesInflight.store"
import useTextEditorStore from "@/stores/useTextEditor.store"
import { useShallow } from "zustand/shallow"
import { useEffect, useCallback, useRef } from "react"
import { runEffect, run } from "@filen/utils"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import prompts from "@/lib/prompts"
import { sync, hashNoteContent } from "@/features/notes/components/sync"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"
import { useTranslation } from "react-i18next"
import { useChecklistHideCompleted } from "@/features/notes/checklistView"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"

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

// M1 + D3: pure builder for a note's inflight entry list after a keystroke. Exported so the
// standalone test exercises the live derivation (T5 pattern).
//
// M1: the author timestamp is PER-NOTE MONOTONIC — `max(Date.now(), newest existing + 1)` —
// so a backward clock step (NTP correction mid-editing) can never leave an OLDER entry
// outranking the text just typed: sync's max-timestamp pick would push the stale entry and
// its `> syncedUpTo` prune would then discard the newest text. All comparisons stay
// local-vs-local; server clocks are never consulted.
//
// D3: an ongoing session CARRIES its existing base hash forward unchanged (including the
// legacy no-hash grace for entries persisted by older app versions — stamping a fresh base
// mid-session would claim a sync point the session never had). Only a FRESH session (no
// existing entries) stamps `sessionBaseHash` — the hash of the synced/loaded content the
// editor was seeded from, or none when nothing synced is known.
export function buildInflightEntries({
	previous,
	note,
	content,
	now,
	sessionBaseHash
}: {
	previous: InflightContent[string] | undefined
	note: Note
	content: string
	now: number
	sessionBaseHash: string | null
}): InflightContent[string] {
	const entries = previous ?? []
	const newestExisting = entries.reduce((acc, c) => (c.timestamp > acc ? c.timestamp : acc), Number.NEGATIVE_INFINITY)
	const timestamp = entries.length > 0 ? Math.max(now, newestExisting + 1) : now
	const newestEntry = entries.find(c => c.timestamp === newestExisting)
	const baseContentHash = entries.length > 0 ? newestEntry?.baseContentHash : (sessionBaseHash ?? undefined)

	return [
		{
			timestamp,
			note,
			content,
			baseContentHash
		},
		// The new keystroke strictly supersedes every existing entry (its timestamp is the
		// monotonic maximum), so this keeps nothing in practice — retained purely as a guard
		// against an exotic concurrent writer racing this functional update.
		...entries.filter(c => c.timestamp > timestamp)
	]
}

// M3: sync.flushToDisk never throws — persistence failure comes back as `false`
// (sync-internal callers ignore it; their next pass re-flushes). HERE it must surface:
// a failed SQLite write means the edit the user just typed survives in memory only and
// would die with the process, with zero signal otherwise. Exported so the test exercises
// the live helper (T5 pattern). Callers still proceed to schedule the push — getting the
// edit to the server is the best remaining chance of not losing it.
export async function flushInflightContentWithAlert(): Promise<void> {
	const flushed = await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

	if (!flushed) {
		alerts.error(i18n.t("note_edit_not_saved_to_device"))
	}
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

function getInflightContentForNote(noteUuid: string): InflightContent[string] | undefined {
	const inflightContent = useNotesInflightStore.getState().inflightContent

	return inflightContent[noteUuid]
}

const Content = ({ note, history }: { note: Note; history?: NoteHistory | null }) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()
	const isOnline = useIsOnline()
	const hasInflightContent = useNotesInflightStore(useShallow(state => (state.inflightContent[note.uuid] ?? []).length > 0))
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

	// The editor seed is FROZEN per (note, fetch generation). The editors OWN their text
	// after mount — mirroring the inflight store's latest content back into this prop
	// created an echo loop (keystroke → store write → prop change → Checklist re-hydration
	// / DOM prop churn → focus + cursor loss on every keystroke). So the seed recomputes
	// ONLY on a real reseed event: a different note or a completed fetch (dataUpdatedAt —
	// the same signal that drives the TextEditor remount key). Sources are read
	// NON-reactively inside, freshest first (#38 semantics preserved): unsynced inflight
	// edit wins (cold open with a restored queue must never paint stale pre-edit content)
	// → per-note content cache (kept truthful by sync's post-push write, so a reseed after
	// a drain paints exactly what was typed) → persisted list copy (offline fallback —
	// the note list is in SQLite even when the disabled per-note query never resolved).
	const editorSeed = (() => {
		if (history) {
			return history.content
		}

		const entries = getInflightContentForNote(note.uuid)

		if (entries && entries.length > 0) {
			let latest: (typeof entries)[number] | null = null

			for (const entry of entries) {
				if (!latest || entry.timestamp > latest.timestamp) {
					latest = entry
				}
			}

			if (latest) {
				return latest.content
			}
		}

		const cached = noteContentQueryGet({
			uuid: note.uuid
		})

		if (typeof cached === "string") {
			return cached
		}

		return null
	})()

	const initialValue = editorSeed

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

	// D3: hash of the synced/loaded content the CURRENT editing session is based on. A
	// "session" starts when the editor loads synced content and renews after a successful
	// push — `buildInflightEntries` stamps this onto the FIRST entry of a session and
	// carries it forward for the rest (so the ref is only consulted while no inflight
	// entries exist for this note).
	const sessionBaseHashRef = useRef<string | null>(null)

	// D3 session boundary — the base renews whenever a fresh seed value arrives with no
	// session ongoing (its base lives in the entries and must not move under it; history
	// views are read-only). This single boundary covers every drain type because the seed
	// sources are kept truthful: after a successful PUSH, sync writes the pushed content
	// into the per-note query cache, so `editorSeed` advances to exactly what was pushed
	// (typing again after a 3s debounce push never false-flags our own push as a conflict);
	// after a 3-STRIKE DROP nothing was pushed, the cache still holds the cloud content,
	// and the base correctly stays/returns there — stamping the dropped text instead (the
	// old "queue drained" boundary) produced a false "overwrote newer changes" toast on the
	// next successful session.
	useEffect(() => {
		if (history) {
			return
		}

		const entries = useNotesInflightStore.getState().inflightContent[note.uuid] ?? []

		if (entries.length > 0) {
			return
		}

		sessionBaseHashRef.current = typeof editorSeed === "string" ? hashNoteContent(editorSeed) : null
	}, [history, note.uuid, editorSeed])

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
			// M1: per-note monotonic timestamp + D3: session base hash — see buildInflightEntries.
			[note.uuid]: buildInflightEntries({
				previous: prev[note.uuid],
				note,
				content: value,
				now,
				sessionBaseHash: sessionBaseHashRef.current
			})
		}))

		// M3: alerts when the SQLite write fails (the edit is memory-only) but never bails —
		// the debounced push below is the best remaining chance of preserving it.
		await flushInflightContentWithAlert()

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
				logger.error("notes", "reload-remote-edit prompt failed", { error: promptResponse.error })
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

				// VC3: this clear happens outside a sync pass, so reset the note's strike count
				// too — otherwise a stale count leaks into the next editing session.
				sync.clearRejections(note.uuid)

				await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

				return await refetch()
			})

			if (!result.success) {
				logger.error("notes", "reload remote edit failed", { error: result.error, noteUuid: note.uuid })
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
			<ListEmpty
				icon="alert-circle-outline"
				title={t("error_generic")}
				action={
					<Button
						onPress={() => {
							void refetch()
						}}
					>
						{t("try_again")}
					</Button>
				}
			/>
		)
	}

	return (
		<Loading
			loading={loading}
			noteType={note.noteType}
		>
			{note.noteType === NoteType.Checklist ? (
				<Checklist
					// Needs a key to reset the editor when the note changes.
					// #38 fix: this key stays STABLE across the inflight window — while
					// inflight content exists the per-note query is disabled (enabled gate
					// above) so `dataUpdatedAt` never advances, so the editor is not
					// remounted mid-edit. It only changes when a fresh fetch completes
					// (no inflight in the way), which is the intended fresh-content reseed —
					// and `initialValue` now seeds from inflight first, so even that reseed
					// can never repaint stale pre-edit content over in-progress work.
					key={history ? undefined : noteContentQuery.dataUpdatedAt}
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
