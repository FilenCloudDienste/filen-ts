import { NoteType } from "@filen/sdk-rs"
import { type Note, type NoteHistory } from "@/types"
import View from "@/components/ui/view"
import useNoteContentQuery, {
	noteContentQueryGet,
	noteContentQueryUpdate,
	noteContentQueryReadSinceSocketReconnect
} from "@/features/notes/queries/useNoteContent.query"
import Checklist from "@/features/notes/components/content/checklist"
import { noteCodeTitleExtension, noteTypeToEditorType } from "@/features/notes/utils"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { ActivityIndicator, Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import TextEditor from "@/components/textEditor"
import { useStringifiedClient } from "@/lib/auth"
import useNotesInflightStore, {
	type InflightContent,
	newestInflightEntry,
	useNoteHasInflight
} from "@/features/notes/store/useNotesInflight.store"
import useNotesOfflineStore from "@/features/notes/store/useNotesOffline.store"
import useTextEditorStore from "@/stores/useTextEditor.store"
import { useShallow } from "zustand/shallow"
import { useEffect, useCallback, useRef } from "react"
import { run, conflictCopyStamp, hashNoteContent, buildInflightEntries } from "@filen/shared"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import prompts from "@/lib/prompts"
import notes from "@/features/notes/notes"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { sync } from "@/features/notes/components/sync"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useHeaderHeight } from "expo-router/react-navigation"
import useIsOnline from "@/hooks/useIsOnline"
import useSocketStore, { onSocketReconnected } from "@/stores/useSocket.store"
import { createUnlockedToaster, unlockedForegroundGate, whenUnlockedForeground } from "@/lib/unlockedForeground"
import { notesQueryGet } from "@/features/notes/queries/useNotesQuery"
import logger from "@/lib/logger"
import { noteDisplayTitle } from "@/lib/decryption"
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

// Fix B (data-safety): the note's content is UNAVAILABLE — never fetched, or aged out of the
// query cache (a maxAge/gcTime TTL now evicts it), with no inflight draft — exactly when the frozen
// editor seed is NOT a string. A genuinely empty note seeds "", not null/undefined; a history view
// always carries its own content. Exported pure so the standalone test guards the invariant (T5),
// and consumed at BOTH the write gate and the offline render branch: an unavailable note must never
// render an EDITABLE EMPTY editor, because its first keystroke — or a single ungated checklist tap —
// would push empty content over the real note on the next sync (silent data loss, especially offline
// where the per-note query is disabled and can never resolve).
export function isNoteContentUnavailable({
	history,
	initialValue
}: {
	history: boolean
	initialValue: string | null | undefined
}): boolean {
	return !history && typeof initialValue !== "string"
}

/**
 * D3: base hash for a NEW editing session (no inflight entries yet) — the hash of the per-note
 * content cache, which sync's post-push write keeps equal to the cloud content at every drain
 * boundary. Read at the instant the session starts (inside onValueChange), NOT maintained by a
 * render-keyed effect: the old sessionBaseHashRef only renewed when the editor-seed STRING
 * changed across a drain, which single-keystroke sessions and incidental re-renders defeat —
 * leaving a stale mount-time base that flagged every later solo push as a self-conflict
 * ("overwrote newer remote changes" toasts while editing alone). Ongoing sessions return null;
 * buildInflightEntries carries the existing base forward.
 */
export function sessionBaseHashForNewSession(entries: InflightContent[string] | undefined, cachedContent: unknown): string | null {
	if (entries && entries.length > 0) {
		return null
	}

	return typeof cachedContent === "string" ? hashNoteContent(cachedContent) : null
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

// A note's newest local content: its newest unsynced edit, else what its content query holds (the last push
// or the seed).
function latestLocalNoteContent(noteUuid: string): string | undefined {
	const cached: unknown = noteContentQueryGet({
		uuid: noteUuid
	})

	return newestInflightEntry(getInflightContentForNote(noteUuid))?.content ?? (typeof cached === "string" ? cached : undefined)
}

// Whether `cloud` differs from what this device last knew the note to hold: its unsynced edits' base, else
// the content cache (the last push or read).
export function movedPastBase(noteUuid: string, cloud: string): boolean {
	const newest = newestInflightEntry(getInflightContentForNote(noteUuid))

	if (newest?.baseContentHash !== undefined) {
		return hashNoteContent(cloud) !== newest.baseContentHash
	}

	const cached: unknown = noteContentQueryGet({
		uuid: noteUuid
	})

	return typeof cached === "string" && cached !== cloud
}

const Content = ({ note, history }: { note: Note; history?: NoteHistory | null }) => {
	const { t } = useTranslation()
	const stringifiedClient = useStringifiedClient()
	const insets = useSafeAreaInsets()
	const headerHeight = useHeaderHeight()
	const isOnline = useIsOnline()
	const hasInflightContent = useNoteHasInflight(note.uuid)
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
	// cursor. A mount still refetches unless the hook finds the cached body
	// current (read this session, socket up since, no remote edit announced
	// after); refetchOnReconnect:"always" bypasses the stale check too when no
	// inflight is in the way. Catch-up for remote edits arrives via the socket
	// → onContentEditedRemotely reload prompt below.
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
	// a drain paints exactly what was typed). When none of these has content — never fetched,
	// or aged out of the query cache (the 90-day maxAge now evicts it), with no inflight draft —
	// the seed is null and the note renders read-only "unavailable offline" (isNoteContentUnavailable
	// / contentUnavailable below) rather than an editable empty editor whose first keystroke or
	// checklist tap could push empty over the real note. (The pre-refactor "persisted list copy"
	// fallback is gone — the notes list query is metadata-only and carries no content.)
	const editorSeed = history ? history.content : (latestLocalNoteContent(note.uuid) ?? null)

	const initialValue = editorSeed

	// Fix B: true when the note's content could not be resolved (never fetched / aged out of the
	// cache, no inflight draft) — drives the read-only "unavailable offline" render branch below and
	// hard-gates the write path so nothing can push an empty seed over the real note.
	const contentUnavailable = isNoteContentUnavailable({
		history: Boolean(history),
		initialValue
	})

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
		if (history || !hasWriteAccess || contentUnavailable) {
			return
		}

		const now = Date.now()

		// D3: stamp a NEW session's base from the content cache at this exact instant (see
		// sessionBaseHashForNewSession). Synchronous read-then-set is race-free on the JS thread.
		const sessionBaseHash = sessionBaseHashForNewSession(
			getInflightContentForNote(note.uuid),
			noteContentQueryGet({
				uuid: note.uuid
			})
		)

		useNotesInflightStore.getState().setInflightContent(prev => ({
			...prev,
			// M1: per-note monotonic timestamp + D3: session base hash — see buildInflightEntries.
			[note.uuid]: buildInflightEntries({
				previous: prev[note.uuid],
				note,
				content: value,
				now,
				sessionBaseHash
			})
		}))

		// M3: alerts when the SQLite write fails (the edit is memory-only) but never bails —
		// the debounced push below is the best remaining chance of preserving it.
		await flushInflightContentWithAlert()

		sync.syncDebounced()
	}

	// Reload the note from the server, dropping any unsynced local content first — otherwise sync.tsx would
	// later push it back over the version being loaded. Clearing inflight also re-enables the query
	// (enabled gate above) so refetch() can remount the editor with the fresh server content.
	const reloadFromServer = useCallback(async () => {
		const result = await run(async () => {
			await sync.discardInflight(note.uuid)

			return await refetch()
		})

		if (!result.success) {
			logger.error("notes", "reload remote edit failed", { error: result.error, noteUuid: note.uuid })
			alerts.error(result.error)
		}
	}, [note.uuid, refetch])

	// Remote changes are answered one at a time, in arrival order. `latest` numbers the newest socket event:
	// an older one still waiting behind a prompt is dropped, the newer one answers for both.
	const remoteQueue = useRef<{
		tail: Promise<void>
		latest: number
		closed: boolean
		toaster: ReturnType<typeof createUnlockedToaster> | null
	}>({ tail: Promise.resolve(), latest: 0, closed: false, toaster: null })

	// A newer version of this note, saved by someone else or on another device (the socket handler drops
	// this device's own pushes), or found by a re-read after the socket was down. Decided on the local state
	// of the moment, as an earlier prompt's answer can have changed it. Clean (no unsynced edits): take it,
	// and say so. Unsynced edits: ask Keep mine (also what dismissing does), Load theirs, or Save mine as
	// copy, a new note beside this one.
	const answerRemoteContent = useCallback(
		async (content: string | undefined, superseded: () => boolean) => {
			if (history) {
				return
			}

			if (content !== undefined && content === latestLocalNoteContent(note.uuid)) {
				return
			}

			// Already answered: the unsynced edits were kept over exactly this content.
			if (content !== undefined && newestInflightEntry(getInflightContentForNote(note.uuid))?.baseContentHash === hashNoteContent(content)) {
				return
			}

			if ((getInflightContentForNote(note.uuid) ?? []).length === 0) {
				if (content === undefined) {
					await reloadFromServer()
				} else {
					// Seeded from the content in this same tick: no request, and no await for a keystroke to land in
					// before the editor reseeds (a fresh dataUpdatedAt remounts it on this content).
					noteContentQueryUpdate({
						params: {
							uuid: note.uuid
						},
						updater: content
					})
				}

				remoteQueue.current.toaster?.notify("updated", t("remote_change_updated"))

				return
			}

			// Until answered, no pass pushes this note: a push under the prompt would put mine over theirs
			// before the user chose.
			const held = sync.hold(note.uuid)

			try {
				// The native alert, note title and all, would draw over the biometric lock.
				await whenUnlockedForeground()

				if (superseded()) {
					return
				}

				const promptResponse = await run(async () => {
					return await prompts.confirm3({
						title: t("note_edited"),
						message: t("note_edited_message"),
						primaryText: t("remote_change_save_copy"),
						destructiveText: t("remote_change_load_theirs"),
						cancelText: t("remote_change_keep_mine"),
						// The app can lock while this waits for its turn.
						gate: unlockedForegroundGate
					})
				})

				if (!promptResponse.success) {
					logger.error("notes", "remote-edit prompt failed", { error: promptResponse.error })
					alerts.error(promptResponse.error)

					return
				}

				// A push sent before the prompt opened lands first: what it left, and its cache write, are what
				// the answer builds on.
				await held.settled

				if (promptResponse.data === "cancel") {
					// The edits become the newest version, pushed once released, against this version's content
					// as the base so the push, which the user chose, raises no overwrite warning.
					const theirsHash = content === undefined ? undefined : hashNoteContent(content)

					if ((getInflightContentForNote(note.uuid) ?? []).length > 0) {
						useNotesInflightStore.getState().setInflightContent(prev => {
							const entries = prev[note.uuid]

							if (!entries) {
								return prev
							}

							return {
								...prev,
								[note.uuid]: entries.map(({ baseContentHash: _stale, ...entry }) =>
									theirsHash === undefined ? entry : { ...entry, baseContentHash: theirsHash }
								)
							}
						})
					} else {
						// That push drained the edits meanwhile, possibly under their version: queue them again.
						const mine = latestLocalNoteContent(note.uuid)

						if (mine === undefined || mine === content) {
							return
						}

						useNotesInflightStore.getState().setInflightContent(prev => ({
							...prev,
							[note.uuid]: buildInflightEntries({
								previous: prev[note.uuid],
								note,
								content: mine,
								now: Date.now(),
								sessionBaseHash: theirsHash ?? null
							})
						}))
					}

					await flushInflightContentWithAlert()

					return
				}

				const mine = latestLocalNoteContent(note.uuid)

				if (promptResponse.data === "primary" && mine !== undefined) {
					const title = t("note_conflict_copy_title", {
						title: noteDisplayTitle(note),
						date: conflictCopyStamp(new Date())
					})
					const copied = await runWithLoading(async () => notes.create({ title, content: mine, type: note.noteType }))

					if (!copied.success) {
						logger.error("notes", "saving remote-edit conflict copy failed", { error: copied.error, noteUuid: note.uuid })
						alerts.error(copied.error)

						return
					}

					remoteQueue.current.toaster?.notify("savedAsCopy", t("note_saved_as_copy", { title }))
				}

				await reloadFromServer()
			} finally {
				held.release()
			}
		},
		[note, history, reloadFromServer, t]
	)

	const answerRemoteContentRef = useRef(answerRemoteContent)

	useEffect(() => {
		answerRemoteContentRef.current = answerRemoteContent
	})

	useEffect(() => {
		const queue = remoteQueue.current

		queue.closed = false
		// Toasts wait for the unlock, the latest only, and none once the editor is gone.
		queue.toaster = createUnlockedToaster(message => {
			alerts.normal(message)
		})

		return () => {
			queue.closed = true
			queue.toaster?.dispose()
			queue.toaster = null
		}
	}, [])

	useEffect(() => {
		if (history) {
			return
		}

		const uuid = note.uuid
		const queue = remoteQueue.current

		const enqueue = (task: () => Promise<void>) => {
			queue.tail = queue.tail
				.then(async () => {
					if (!queue.closed) {
						await task()
					}
				})
				.catch((e: unknown) => {
					logger.error("notes", "answering a remote edit failed", { error: e, noteUuid: uuid })
				})
		}

		// A pass that finds an edit made elsewhere under unsynced edits hands it here instead of pushing.
		const detachEditor = sync.attachEditor(uuid)

		const noteContentEditedSubscription = events.subscribe("noteContentEdited", info => {
			if (info.noteUuid !== uuid) {
				return
			}

			const sequence = ++queue.latest
			// Also once the editor closed while this waited for the unlock: nothing here can answer it then.
			const superseded = () => queue.closed || sequence !== queue.latest

			enqueue(async () => {
				if (!superseded()) {
					await answerRemoteContentRef.current(info.content, superseded)
				}
			})
		})

		// While the socket was down (a background tears it down, on iOS and Android alike) an edit made
		// elsewhere reached no event: read the content once and answer it like one when it moved past the base.
		const unsubscribeReconnected = onSocketReconnected(() => {
			const sequence = queue.latest
			const superseded = () => queue.closed || sequence !== queue.latest

			enqueue(async () => {
				// The content query's own read since the reconnect (a reconnect refetch of a clean note) already
				// brought the note up to date.
				if (noteContentQueryReadSinceSocketReconnect({ uuid })) {
					return
				}

				// No pass pushes under the read, so a difference is someone else's edit, never this device's push.
				const held = sync.hold(uuid)

				try {
					await held.settled

					// A pass that ran meanwhile handed its finding over, and that answers after this; or its peek,
					// begun since the reconnect, found nothing to hand over.
					if (superseded() || sync.peekedSince(uuid, useSocketStore.getState().connectedAt)) {
						return
					}

					const read = await run(async () =>
						notes.getContent({ note: notesQueryGet()?.find(listed => listed.uuid === uuid) ?? note })
					)

					if (!read.success) {
						logger.warn("notes", "re-reading an open note after a socket gap failed", { error: read.error, noteUuid: uuid })

						return
					}

					// An event arrived since, and answers after this.
					if (read.data === undefined || superseded() || !movedPastBase(uuid, read.data)) {
						return
					}

					await answerRemoteContentRef.current(read.data, superseded)
				} finally {
					held.release()
				}
			})
		})

		return () => {
			detachEditor()
			noteContentEditedSubscription.remove()
			unsubscribeReconnected()
		}
	}, [note, history])

	// Announce that a content view for this note is mounted, so the offline sync pass knows not to
	// replace the body under it. The route pathname cannot answer this: pushing /noteHistory or
	// /noteParticipants from the header leaves this component mounted (frozen, not unmounted), and a
	// pathname test would report the editor closed while the user is one back-swipe from it.
	useEffect(() => {
		const uuid = note.uuid

		useNotesOfflineStore.getState().openContentView(uuid)

		return () => {
			useNotesOfflineStore.getState().closeContentView(uuid)
		}
	}, [note.uuid])

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

	// Fix B: offline with unavailable content — the per-note query is disabled offline so it can
	// never resolve, and an editable empty editor here would let a keystroke (or a single ungated
	// checklist tap) push empty over the real note on the next sync. Render a read-only surface
	// instead; the write gate above is the defense-in-depth backstop for any other unavailable path.
	if (contentUnavailable && !isOnline) {
		return (
			<ListEmpty
				icon="cloud-offline-outline"
				title={t("note_content_unavailable_offline")}
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
					// Code notes highlight by the TITLE's extension ("script.py" → python). Only a
					// usable extension is passed — otherwise the editor keeps its default; the
					// WebView side validates against the known language set (loadLanguage).
					fileName={note.noteType === NoteType.Code && noteCodeTitleExtension(note.title) !== null ? note.title : undefined}
					id={`note:${note.uuid}`}
					// iOS lays this editor out UNDER its translucent header, and the WebView no longer
					// insets its own content by the safe area (see DOM_HOST_WEBVIEW_PROPS) — so the offset
					// has to be stated, exactly as the checklist editor states it. Android's header is
					// opaque and the editor already starts below it, so the padding must not apply there.
					//
					// `+ 16` for the same reason the checklist adds it: this REPLACES the editor's own top
					// padding rather than adding to it, so without it the first line sits flush against the
					// header — which on a note opening with an H1 reads as touching it.
					paddingTop={Platform.OS === "ios" ? headerHeight + 16 : undefined}
					paddingBottom={insets.bottom}
				/>
			)}
		</Loading>
	)
}

export default Content
