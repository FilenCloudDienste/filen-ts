import { run, Semaphore } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix } from "@/lib/kvScan"
import { deserialize } from "@/lib/serializer"
import logger from "@/lib/logger"
import i18n from "@/lib/i18n"
import { type Note } from "@/types"
import { fetchData as notesQueryFetch } from "@/features/notes/queries/useNotesQuery"
import { noteContentQueryGet, noteContentQueryKey, noteContentQueryUpdate } from "@/features/notes/queries/useNoteContent.query"
import { getContent } from "@/features/notes/notesContent"
import useNotesInflightStore, { type InflightContent, INFLIGHT_CONTENT_SQLITE_KV_KEY } from "@/features/notes/store/useNotesInflight.store"
import useNotesOfflineStore from "@/features/notes/store/useNotesOffline.store"
import useAppStore from "@/stores/useApp.store"
import { removeQueryEverywhere, queryClientPersisterKv } from "@/queries/client"

// Per-note ledger rows: `notesOffline:marked:<uuid>`. One row per marked note so a mark/unmark is a
// point write instead of a rewrite of the whole set.
const MARKED_PREFIX = "notesOffline:marked:"
// Per-uuid rows for bodies whose eviction had to be deferred (see queueEviction). Same one-row-per-
// entry shape and for the same reason: a single shared list row would be a read-modify-write, and
// these are written from OUTSIDE the sync mutex (un-mark is a menu tap), so concurrent writers would
// drop each other's entries — and a dropped entry is a decrypted body nothing ever reclaims.
// Sorts strictly below MARKED_PREFIX ("evict" < "marked"), so neither prefix scan sees the other.
const PENDING_EVICTION_PREFIX = "notesOffline:evict:"

// Bounds concurrent getNoteContent calls. Note bodies are small, but a 200-note ledger firing 200
// simultaneous requests would starve everything else sharing the SDK's TPS budget. Shared by the sync
// pass AND the socket-driven refresh — a bulk remote edit can otherwise fan out just as wide.
const FETCH_CONCURRENCY = 3

// Floor between two AUTOMATIC passes. Every `inactive -> active` flip reaches sync(): Face ID, the
// share sheet, a permission dialog, an app-switcher peek. Without a floor, five quick peeks are five
// full listNotes round trips. Background runs bypass it — they fire rarely and are the whole point.
export const AUTO_SYNC_MIN_INTERVAL_MS = 60_000

type KvCommand = [string, (string | Uint8Array)[]]

/**
 * Ledger value for one marked note.
 *
 * `editedTimestamp` is the note's server edit stamp AT THE MOMENT its body was last written into the
 * content cache, stringified (the SDK type is a bigint; string keeps equality comparisons and JSON
 * round-trips boring). `null` means "marked but no body committed yet" — the state a mark lands in
 * when its fetch could not be committed, and the state that makes the next pass fetch it.
 *
 * This is the freshness oracle: `listNotes` already returns `editedTimestamp` for every note in ONE
 * call, so a pass can decide exactly which bodies are stale without a single per-note request.
 */
export type NoteOfflineEntry = {
	editedTimestamp: string | null
}

export type NoteOfflineSyncPlan = {
	// Marked uuids whose cached body is missing or older than the note's current edit stamp.
	fetch: string[]
	// Marked uuids the account no longer has (deleted, or a shared note we were removed from).
	prune: string[]
}

// Stringified edit stamp for a note — the ledger's freshness key. Centralised so the writer and the
// comparer can never disagree about bigint-vs-string.
export function noteEditedStamp(note: Pick<Note, "editedTimestamp">): string {
	return String(note.editedTimestamp)
}

/**
 * Decides what one sync pass must do. Pure — no store, kv, or network access — so the decision table
 * is unit-testable without any native module in scope.
 *
 * A marked note is fetched when its body is absent from the content cache OR the ledger's stamp no
 * longer matches the note's current edit stamp (someone edited it elsewhere). Two exclusions:
 *
 *  - notes carrying unsynced local edits, whose draft is the newest truth: overwriting the cached
 *    body underneath one would re-base the conflict detection in components/sync against content the
 *    user never saw.
 *  - notes on screen that already have a body, which `commitContent` would refuse to overwrite
 *    anyway. Excluding them here turns a wasted download-and-discard on every pass into nothing.
 */
export function planNoteOfflineSync({
	marked,
	notes,
	inflightUuids,
	cachedUuids,
	openUuids
}: {
	marked: Map<string, NoteOfflineEntry>
	notes: Note[]
	inflightUuids: Set<string>
	cachedUuids: Set<string>
	openUuids: Set<string>
}): NoteOfflineSyncPlan {
	const byUuid = new Map<string, Note>()

	for (const note of notes) {
		byUuid.set(note.uuid, note)
	}

	const fetch: string[] = []
	const prune: string[] = []

	for (const [uuid, entry] of marked) {
		const note = byUuid.get(uuid)

		if (!note) {
			prune.push(uuid)

			continue
		}

		if (note.undecryptable || inflightUuids.has(uuid) || (openUuids.has(uuid) && cachedUuids.has(uuid))) {
			continue
		}

		if (entry.editedTimestamp !== noteEditedStamp(note) || !cachedUuids.has(uuid)) {
			fetch.push(uuid)
		}
	}

	return {
		fetch,
		prune
	}
}

/**
 * Whether the note detail route for this uuid is the screen the user is currently on.
 *
 * Load-bearing for data safety, not just for polish. The editor seed is frozen at mount and its
 * remount key is the content query's `dataUpdatedAt`, so replacing an EXISTING body for the note on
 * screen would either yank the editor out from under the user (remount, cursor lost) or — worse, if
 * the timestamp were held stable — leave the editor showing OLD text while
 * `sessionBaseHashForNewSession` reads the NEW text as the session's base hash. The user's next
 * keystroke would then push old-derived content stamped as if it were based on the newer remote
 * edit, and components/sync's overwrite detection would stay silent about burying it.
 *
 * So: this module never REPLACES a differing cached body for the note being viewed — the
 * "note edited elsewhere — reload?" prompt owns that case, and it is the user's call. Writing a body
 * the cache does not have yet is still allowed: there is no editor state to diverge from, and the
 * screen is showing a loader or the unavailable-offline surface.
 */
export function isNoteScreenOpen(uuid: string): boolean {
	// Primary signal: a content view for this note is actually MOUNTED (components/content registers
	// itself). Survives /noteHistory and /noteParticipants being pushed on top, which freeze the
	// editor rather than unmounting it — a pathname test alone reports "closed" there and would let a
	// pass repaint an editor the user is one back-swipe away from.
	if ((useNotesOfflineStore.getState().openContentViews[uuid] ?? 0) > 0) {
		return true
	}

	// Secondary: the route is showing this note but its content view has not mounted yet (navigation
	// dispatched, first render pending). Both signals fail in the SAFE direction — a false positive
	// only defers a body refresh to the next pass.
	const pathname = useAppStore.getState().pathname
	const route = `/note/${uuid}`

	// Segment-exact, not a bare prefix test: `startsWith` would also match a longer uuid that merely
	// begins with this one. Unreachable with fixed-length v4 uuids, but this predicate is what stands
	// between a background pass and the text under the user's cursor — it should not depend on that.
	return pathname === route || pathname.startsWith(`${route}/`)
}

/**
 * Narrows what `getNoteContent` returned to a body we may actually cache.
 *
 * `undefined` is NOT an empty note — the SDK returns `Some("")` for that. It means the note HAS
 * content that could not be decrypted (notes.rs: `NoteContent::blocking_try_decrypt(...).ok()`), and
 * such a note is not flagged `undecryptable`, so it renders normally in the list.
 *
 * Coalescing it to `""` would be silent data loss, not a cosmetic slip: an empty string is a valid
 * body, so it sails through `isNoteContentUnavailable` and the editor opens EDITABLE and EMPTY. The
 * first keystroke stamps the session base as `hash("")`; components/sync's overwrite peek coalesces
 * the cloud content the same way, so the hashes match, no conflict is reported, and the push replaces
 * the real note with whatever was typed.
 */
function isCacheableBody(content: string | undefined): content is string {
	return typeof content === "string"
}

function inflightUuidsFromContent(inflight: InflightContent): Set<string> {
	const uuids = new Set<string>()

	for (const uuid of Object.keys(inflight)) {
		if ((inflight[uuid] ?? []).length > 0) {
			uuids.add(uuid)
		}
	}

	return uuids
}

function inflightUuidSet(): Set<string> {
	return inflightUuidsFromContent(useNotesInflightStore.getState().inflightContent)
}

/**
 * Durable, feature-owned "keep this note on the device" ledger plus the pass that keeps the marked
 * bodies current.
 *
 * Bodies are NOT stored separately — they live in the per-note content query cache, which is already
 * persisted to SQLite and already the editor's read path. Marking a note therefore adds no new
 * storage format and needs no changes in components/content: it only guarantees that the body is
 * fetched even if the note was never opened, and that it is refreshed when someone edits the note
 * elsewhere. Un-marking reclaims the bytes.
 *
 * The ledger lives in the kv rather than the query cache specifically so a headless background run
 * can read it after `setup()` without depending on any component having mounted.
 */
export class NotesOffline {
	private readonly marked = new Map<string, NoteOfflineEntry>()
	private readonly syncMutex = new Semaphore(1)
	// Serializes the per-uuid eviction bookkeeping against itself. NOT syncMutex: queueEviction runs
	// inside a mutex-held pass (via the prune path) as well as from a menu tap outside it.
	private readonly evictionMutex = new Semaphore(1)
	// Shared by the socket-driven refresh AND the sync pass's fan-out, so their combined concurrency
	// respects one bound rather than two independent ones.
	private readonly refreshSemaphore = new Semaphore(FETCH_CONCURRENCY)
	// Notes with a socket-driven refresh in flight, so a burst for the same note collapses.
	private readonly refreshing = new Set<string>()

	private loaded = false
	private loadPromise: Promise<void> | null = null

	// Set by clearForLogout and NEVER cleared. The ledger is account-scoped and logout ends in a JS
	// bundle reload, which constructs a fresh instance — so there is nothing to un-latch, and a latch
	// the next caller clears is not a latch at all. (cameraUploadState un-latches on its next load;
	// that is safe there only because its loads are unreachable after logout. Here `sync()` starts
	// with one, so the same shape would re-enable writes seconds before the kv wipe.)
	private locked = false
	// Bumped by clearForLogout. A load in flight during a wipe captures it before scanning and
	// discards its results if it changed, so stale disk rows never repopulate the next account.
	private generation = 0

	private abortController = new AbortController()
	// In-flight pass, for coalescing. Overlapping triggers JOIN this instead of queueing behind the
	// mutex and each running a full listNotes.
	private inFlight: Promise<void> | null = null
	// Whether the in-flight pass bypasses the min-interval floor. A privileged caller must not join an
	// un-privileged pass and inherit its floor — see sync().
	private inFlightPrivileged = false
	private lastCompletedPassAt: number | null = null

	/**
	 * Aborts an in-flight pass. Used by the background task's run-budget deadline and by logout.
	 * A cancelled pass leaves the ledger untouched for every note it had not yet committed, so the
	 * next pass simply re-converges.
	 */
	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	/**
	 * Pages the ledger into memory and mirrors it into the store. Single-flight and idempotent.
	 *
	 * Callers must not gate this on connectivity: an offline boot still has to render badges for the
	 * notes the user marked, so `sync()` loads before it checks `onlineManager`. They MUST gate it on
	 * `locked` — a load after logout would scan the outgoing account's rows.
	 */
	public load(): Promise<void> {
		if (this.loaded || this.locked) {
			return Promise.resolve()
		}

		if (this.loadPromise) {
			return this.loadPromise
		}

		const promise = this.doLoad().finally(() => {
			if (this.loadPromise === promise) {
				this.loadPromise = null
			}
		})

		this.loadPromise = promise

		return promise
	}

	private async doLoad(): Promise<void> {
		const generation = this.generation
		const scanned = new Map<string, NoteOfflineEntry>()

		try {
			const db = await sqlite.openDb()
			const badKeys: string[] = []

			await forEachKvRowByPrefix(db, MARKED_PREFIX, (rowKey, value) => {
				// One corrupt row must not cost the user every other mark — drop just that row.
				try {
					scanned.set(rowKey.slice(MARKED_PREFIX.length), deserialize(value) as NoteOfflineEntry)
				} catch {
					badKeys.push(rowKey)
				}
			})

			if (badKeys.length > 0) {
				logger.warn("notes-offline", "Dropping corrupt offline ledger rows", { count: badKeys.length })

				await db.executeBatch(badKeys.map(key => ["DELETE FROM kv WHERE key = ?", [key]] as KvCommand))
			}
		} catch (err) {
			// Deliberately NOT a prefix wipe. This ledger is user INTENT, not a rebuildable shield
			// like the camera-upload hash index: a single SQLITE_BUSY or a failed openDb would
			// otherwise silently un-mark every note the user ever marked, announced by nothing but a
			// warn. Leave the rows and leave `loaded` false so the next trigger retries; a genuinely
			// undecodable row is already handled per-row above.
			logger.warn("notes-offline", "Ledger scan failed — keeping rows on disk and retrying on the next pass", { error: err })

			return
		}

		if (generation !== this.generation) {
			return
		}

		for (const [uuid, entry] of scanned) {
			this.marked.set(uuid, entry)
		}

		this.loaded = true

		this.publishMarked()
	}

	// Mirrors the in-memory ledger into the reactive store. One object rebuild per mutation — the
	// ledger is small (one entry per marked note) and rows compare a single boolean.
	private publishMarked(): void {
		const marked: Record<string, true> = {}

		for (const uuid of this.marked.keys()) {
			marked[uuid] = true
		}

		useNotesOfflineStore.getState().setMarked(marked)
	}

	/**
	 * Writes a ledger row.
	 *
	 * `requireExisting` is for writers whose decision to write was taken BEFORE a network round trip —
	 * the sync pass. Without it, a pass that was mid-fetch when the user un-marked the note resurrects
	 * it: the row comes back, the badge reappears, and the un-mark is durably lost.
	 */
	private async writeEntry(uuid: string, entry: NoteOfflineEntry, options?: { requireExisting?: boolean }): Promise<void> {
		if (this.locked) {
			return
		}

		const isNew = !this.marked.has(uuid)

		if (isNew && options?.requireExisting === true) {
			return
		}

		this.marked.set(uuid, entry)

		// Only a change to the KEY SET can change what the UI shows. A pass that merely advances
		// stamps would otherwise rebuild the projection — and re-run every note row's selector —
		// once per refreshed note.
		if (isNew) {
			this.publishMarked()
		}

		await sqlite.kvAsync.set(MARKED_PREFIX + uuid, entry)
	}

	private async deleteEntry(uuid: string): Promise<void> {
		if (this.locked) {
			return
		}

		if (this.marked.delete(uuid)) {
			this.publishMarked()
		}

		await sqlite.kvAsync.remove(MARKED_PREFIX + uuid)
	}

	/**
	 * Commits a freshly fetched body into the content cache.
	 *
	 * Returns whether the ledger may record this note as current. Three cases, all driven by the
	 * open-editor rule in `isNoteScreenOpen`:
	 *
	 *   - note not on screen → write, advance the ledger.
	 *   - on screen, cached body already identical → nothing to write; the cache IS current at this
	 *     stamp, so advance the ledger. Writing anyway would bump `dataUpdatedAt` and remount the
	 *     editor for a no-op change.
	 *   - on screen, cached body differs → write nothing and do NOT advance, so the next pass retries
	 *     once the user has left. The reload prompt owns this note in the meantime.
	 */
	private commitContent({
		uuid,
		content,
		observedBody
	}: {
		uuid: string
		content: string
		// The cached body as it was BEFORE the fetch that produced `content`.
		observedBody: string | undefined
	}): boolean {
		// A body is decrypted account data; never write one after logout latched.
		if (this.locked) {
			return false
		}

		// Someone else wrote this note's body while we were fetching — almost always components/sync
		// landing the user's own push. Our copy predates it, so writing it would serve the user a body
		// missing their own last edit, and a later editing session would base itself on that.
		//
		// Compares the BODY, not the query's `dataUpdatedAt`. The timestamp cannot answer this: the
		// push in components/sync deliberately passes the PREVIOUS dataUpdatedAt back so the editor's
		// remount key stays stable, so that write changes the body and leaves the stamp untouched —
		// invisible to a timestamp check, and invisible for every marked note, since the fallback bump
		// only happens for a note that was never fetched. Identity is the real invariant; the
		// timestamp is an implementation detail a cooperating writer is allowed to freeze.
		if (noteContentQueryGet({ uuid }) !== observedBody) {
			return false
		}

		// A draft is the newest truth. Checked HERE, synchronously adjacent to the write, so no await
		// can open a window between the check and the commit — the per-caller checks before the fetch
		// only avoid pointless downloads.
		if (inflightUuidSet().has(uuid)) {
			return false
		}

		const cached = noteContentQueryGet({
			uuid
		})

		if (isNoteScreenOpen(uuid)) {
			if (cached === content) {
				return true
			}

			if (typeof cached === "string") {
				logger.debug("notes-offline", "Skipping body write for the note on screen", { noteUuid: uuid })

				return false
			}
		}

		// An unchanged body still must not bump `dataUpdatedAt`: for a note the user has open in a
		// background tab-stack the remount would be pointless, and for every other note the write is
		// simply redundant.
		if (cached === content) {
			return true
		}

		noteContentQueryUpdate({
			params: {
				uuid
			},
			updater: content
		})

		return true
	}

	/**
	 * Marks a note available offline. Fetches the body FIRST and only commits the ledger once it
	 * landed — a mark that could not produce a body must not leave a badge promising one.
	 *
	 * Throws on failure so the calling menu can surface it.
	 */
	public async mark({ note, signal }: { note: Note; signal?: AbortSignal }): Promise<{ committed: boolean }> {
		if (this.locked) {
			return {
				committed: false
			}
		}

		await this.load()

		// Localized because it is user-facing: the menu surfaces this through alerts.error, which
		// renders a plain Error's message verbatim. The menu entry is already `requiresOnline`, but a
		// native menu snapshots its actions at presentation time — connectivity dropping between the
		// menu opening and the tap lands here with the entry still enabled.
		if (!onlineManager.isOnline()) {
			throw new Error(i18n.t("note_offline_requires_connection"))
		}

		const observedBody = noteContentQueryGet({ uuid: note.uuid })

		// Bounded like every other fetch in this module. A single mark passes straight through, but
		// the bulk action marks the whole selection by calling this once per note — without the
		// semaphore that is one concurrent getNoteContent per selected note, which is exactly the
		// fan-out FETCH_CONCURRENCY exists to prevent. try/finally rather than run(), so the throw
		// that the menu surfaces still propagates.
		await this.refreshSemaphore.acquire()

		let content: string | undefined

		try {
			content = await getContent({ note, signal })
		} finally {
			this.refreshSemaphore.release()
		}

		if (signal?.aborted || this.locked) {
			return {
				committed: false
			}
		}

		// Not an empty note — the body exists but could not be decrypted (see isCacheableBody). Fail
		// the mark rather than badging a note whose "offline copy" would be a blank the editor would
		// happily let the user overwrite the real content with.
		if (!isCacheableBody(content)) {
			throw new Error(i18n.t("note_offline_content_undecryptable"))
		}

		const committed = this.commitContent({
			uuid: note.uuid,
			content,
			observedBody
		})

		await this.writeEntry(note.uuid, {
			editedTimestamp: committed ? noteEditedStamp(note) : null
		})

		// A note being marked may sit in the pending-eviction list from an earlier un-mark whose
		// cleanup never got to run. Marking it again supersedes that.
		await this.dropPendingEviction(note.uuid)

		// Force the body to disk rather than leaving it to the persister's debounce. The ledger row is
		// a direct INSERT and lands immediately, so a kill inside the debounce window would otherwise
		// leave a badge promising a body that never persisted — visible to the user as
		// "not available offline" under an "Available offline" badge until the next online pass.
		if (committed && !this.locked) {
			await queryClientPersisterKv.flushNow()
		}

		return {
			committed
		}
	}

	/**
	 * Un-marks a note and reclaims its cached body.
	 *
	 * The body is evicted FIRST, then the ledger row is dropped: a kill between the two then leaves
	 * the note still marked with no body, which the next pass simply re-fetches. The other order
	 * leaves a body with no ledger row — an orphan nothing ever reclaims, since the drain only knows
	 * about DEFERRED evictions.
	 *
	 * Local unsynced edits are never at risk either way: they live in the inflight store, not in the
	 * content cache.
	 */
	public async unmark({ uuid }: { uuid: string }): Promise<void> {
		if (this.locked) {
			return
		}

		await this.load()

		// Only drop the ledger row once the body is provably either gone or durably queued for
		// removal. Bailing here leaves the note marked — visibly still offline, and retryable — which
		// is strictly better than an un-marked note whose decrypted body nothing owns.
		if (!(await this.evictContent(uuid))) {
			throw new Error(i18n.t("note_offline_remove_failed"))
		}

		await this.deleteEntry(uuid)
	}

	/**
	 * Evicts one note's cached body, or defers it when doing so now would disturb live state.
	 *
	 * Deferred when the note is on screen or carries unsynced edits. The inflight case is the sharp
	 * one: components/sync's post-push write passes `noteContentQueryDataUpdatedAt` back to keep the
	 * editor's remount key stable, and with the entry gone that read returns undefined and falls back
	 * to a fresh timestamp — remounting the editor and resetting the cursor mid-edit.
	 */
	private async evictContent(uuid: string): Promise<boolean> {
		if (this.locked) {
			return false
		}

		if (isNoteScreenOpen(uuid) || inflightUuidSet().has(uuid)) {
			return await this.queueEviction(uuid)
		}

		removeQueryEverywhere(noteContentQueryKey({ uuid }))

		// The eviction is a BUFFERED delete behind the persister's 1s debounce, while the ledger row
		// the caller drops next is an immediate write. Force the delete to disk so the on-disk order
		// matches the intended one — otherwise a kill in that window leaves a persisted decrypted body
		// with no ledger row and no queue row, which nothing ever reclaims. Never rejects.
		await queryClientPersisterKv.flushNow()

		return true
	}

	private async queueEviction(uuid: string): Promise<boolean> {
		const result = await run(async defer => {
			await this.evictionMutex.acquire()

			defer(() => {
				this.evictionMutex.release()
			})

			// Re-checked after the mutex, not only before it: a logout landing while we queued must
			// not let this write land in the next account's store.
			if (this.locked) {
				return
			}

			await sqlite.kvAsync.set(PENDING_EVICTION_PREFIX + uuid, true)
		})

		if (!result.success) {
			logger.error("notes-offline", "Could not queue a deferred eviction; keeping the note marked", {
				noteUuid: uuid,
				error: result.error
			})
		}

		return result.success
	}

	private async dropPendingEviction(uuid: string): Promise<void> {
		await run(async defer => {
			await this.evictionMutex.acquire()

			defer(() => {
				this.evictionMutex.release()
			})

			if (this.locked) {
				return
			}

			await sqlite.kvAsync.remove(PENDING_EVICTION_PREFIX + uuid)
		})
	}

	/**
	 * Retries deferred evictions. A uuid that got re-marked in the meantime is simply dropped from the
	 * list — it is wanted again.
	 *
	 * A scan failure leaves every row in place (the rows ARE the queue; forgetting one leaks a body
	 * forever) and returns, so the next pass retries.
	 */
	private async drainPendingEvictions(): Promise<void> {
		await run(async defer => {
			await this.evictionMutex.acquire()

			defer(() => {
				this.evictionMutex.release()
			})

			if (this.locked) {
				return
			}

			const db = await sqlite.openDb()
			const pending: string[] = []

			await forEachKvRowByPrefix(db, PENDING_EVICTION_PREFIX, rowKey => {
				pending.push(rowKey.slice(PENDING_EVICTION_PREFIX.length))
			})

			if (pending.length === 0) {
				return
			}

			// Persisted-inclusive, not the in-memory store alone. A headless run never mounts the
			// component that hydrates that store, so an eviction the foreground deferred BECAUSE the
			// note had unsynced edits would otherwise execute in the background — and the next
			// foreground push would then find no dataUpdatedAt to preserve and remount the editor
			// mid-edit, which is the exact failure the deferral exists to avoid.
			const persistedInflight = await this.inflightUuidsIncludingPersisted()

			for (const uuid of pending) {
				if (this.locked) {
					return
				}

				if (this.marked.has(uuid)) {
					await sqlite.kvAsync.remove(PENDING_EVICTION_PREFIX + uuid)

					continue
				}

				// The persisted view is snapshotted once (it is a kv read), but the in-memory one is
				// re-read per iteration: this loop awaits between entries, so a note can gain a draft
				// while the drain is working through earlier uuids — and evicting then is exactly the
				// mid-edit editor remount the deferral exists to prevent.
				if (isNoteScreenOpen(uuid) || persistedInflight.has(uuid) || inflightUuidSet().has(uuid)) {
					continue
				}

				removeQueryEverywhere(noteContentQueryKey({ uuid }))

				await sqlite.kvAsync.remove(PENDING_EVICTION_PREFIX + uuid)
			}
		})
	}

	// Marked notes carrying unsynced edits, including edits persisted by a previous session that no
	// component has hydrated yet. The in-memory inflight store is filled ONLY by components/sync's
	// restoreFromDisk, which runs from its host component's mount — never in a headless run. Reading
	// the kv row directly is what makes the "never overwrite a draft" rule hold in the background too,
	// rather than being decorative exactly where the feature does most of its work.
	private async inflightUuidsIncludingPersisted(): Promise<Set<string>> {
		const uuids = inflightUuidSet()

		const persisted = await run(async () => await sqlite.kvAsync.get<InflightContent>(INFLIGHT_CONTENT_SQLITE_KV_KEY))

		if (!persisted.success) {
			logger.warn("notes-offline", "Could not read the persisted inflight queue; using the in-memory view only", {
				error: persisted.error
			})

			return uuids
		}

		if (persisted.data) {
			for (const uuid of inflightUuidsFromContent(persisted.data)) {
				uuids.add(uuid)
			}
		}

		return uuids
	}

	/**
	 * Refreshes one note's cached body after a remote edit arrived over the socket.
	 *
	 * Called for ANY note we already hold a body for — not just marked ones. Holding a copy we know
	 * to be wrong is the bug; whether the user asked us to keep it is a separate question. The note
	 * currently on screen is deliberately excluded (see isNoteScreenOpen) — that one gets the reload
	 * prompt instead, so the user decides when their editor is replaced.
	 *
	 * Never throws: this runs from the socket dispatcher.
	 */
	public async refreshAfterRemoteEdit({ note }: { note: Note }): Promise<void> {
		// Captured before any await — cancel() installs a FRESH controller, so reading it later would
		// hand a refresh that started before a cancel the next controller's un-aborted signal.
		const signal = this.abortController.signal

		if (this.locked || isNoteScreenOpen(note.uuid) || inflightUuidSet().has(note.uuid)) {
			return
		}

		// Collapse a burst for the SAME note. Another device's editor pushes on a 3s debounce
		// (components/sync), so a collaborator typing in a shared note emits a ContentEdited every few
		// seconds — and every one of them lands a full body download here. The semaphore bounds
		// concurrency, not volume: ten minutes of co-editing is ~200 downloads for a note the user may
		// never have marked and is not looking at. One in-flight refresh per note, and a later event
		// arriving during it is answered by re-reading the note after the fetch rather than by a second
		// round trip.
		if (this.refreshing.has(note.uuid)) {
			return
		}

		// Latched HERE, before the first await, so the guard covers the whole operation. Adding it
		// after `load()` left a window in which a burst slipped past and every event still fetched.
		this.refreshing.add(note.uuid)

		const result = await run(async defer => {
			defer(() => {
				this.refreshing.delete(note.uuid)
			})

			await this.load()

			const holdsBody = typeof noteContentQueryGet({ uuid: note.uuid }) === "string"

			if (!holdsBody && !this.marked.has(note.uuid)) {
				return
			}

			if (!onlineManager.isOnline()) {
				// The ledger still carries the pre-edit stamp, so the next pass refetches. For an
				// unmarked-but-cached note the stale body simply persists until it is opened online —
				// unchanged from before this refresh existed.
				return
			}

			// Shares the sync pass's bound: a bulk remote edit (another device restoring a batch)
			// otherwise fires one concurrent getNoteContent per event, which is exactly the fan-out
			// FETCH_CONCURRENCY exists to prevent.
			await this.refreshSemaphore.acquire()

			defer(() => {
				this.refreshSemaphore.release()
			})

			if (signal.aborted || this.locked) {
				return
			}

			const observedBody = noteContentQueryGet({ uuid: note.uuid })
			const content = await getContent({ note, signal })

			// Re-checked after the round trip, not only before it. Without this, an un-mark landing
			// mid-fetch is undone: the body is written back with no ledger row to account for it, and
			// nothing ever reclaims it (the drain only knows about DEFERRED evictions).
			if (
				signal.aborted ||
				this.locked ||
				!(this.marked.has(note.uuid) || typeof noteContentQueryGet({ uuid: note.uuid }) === "string")
			) {
				return
			}

			// Undecryptable body — leave whatever we hold rather than replacing it with a blank.
			if (!isCacheableBody(content)) {
				logger.warn("notes-offline", "Remote-edit refresh returned an undecryptable body; keeping the existing copy", {
					noteUuid: note.uuid
				})

				return
			}

			if (!this.commitContent({ uuid: note.uuid, content, observedBody })) {
				return
			}

			if (this.marked.has(note.uuid)) {
				await this.writeEntry(
					note.uuid,
					{
						editedTimestamp: noteEditedStamp(note)
					},
					{
						requireExisting: true
					}
				)
			}
		})

		if (!result.success && !signal.aborted) {
			logger.warn("notes-offline", "Refresh after remote edit failed — leaving the stale body for the next pass", {
				noteUuid: note.uuid,
				error: result.error
			})
		}
	}

	/**
	 * One convergence pass over the marked set.
	 *
	 * Never rejects. A pass that cannot reach the network, or that fails on individual notes, is not
	 * an error the caller should act on — the ledger is left un-advanced for whatever did not land and
	 * the next trigger re-converges. This matters for the background task in particular: a transient
	 * note fetch must not mark an otherwise healthy run as failed.
	 *
	 * Deliberately fetches the notes list itself rather than reading the query cache. The list IS the
	 * freshness oracle, and a cached list carries cached edit stamps — comparing against those would
	 * make the pass believe every body was already current and it would never refresh anything.
	 */
	public sync(options?: { background?: boolean; force?: boolean }): Promise<void> {
		const privileged = options?.background === true || options?.force === true

		// Join an in-flight pass rather than queueing behind the mutex: unlocking the phone fires the
		// foreground transition AND an onlineManager flip, which would otherwise be two full passes
		// back to back.
		//
		// A PRIVILEGED caller (a background run, or reconnect) may only join a pass that is itself
		// privileged. Joining otherwise would silently hand it the running pass's floor: the background
		// task would await a foreground pass that returns at the min-interval gate having fetched
		// nothing, then record `phase: "done", result: "success"` — a no-op that reports as a healthy
		// run, which is exactly what blinds field diagnosis. There is no fallback to queue behind,
		// because `inFlight` is only cleared after the mutex is already released.
		if (this.inFlight && !(privileged && !this.inFlightPrivileged)) {
			return this.inFlight
		}

		const previous = this.inFlight
		const start = async (): Promise<void> => {
			// Let the un-privileged pass finish first so the two don't interleave on the ledger; its
			// rejection is impossible (runPass never throws) but is neutralised anyway.
			if (previous) {
				await previous.catch(() => undefined)
			}

			await this.runPass(options)
		}

		const promise = start().finally(() => {
			if (this.inFlight === promise) {
				this.inFlight = null
				this.inFlightPrivileged = false
			}
		})

		this.inFlight = promise
		this.inFlightPrivileged = privileged

		return promise
	}

	private async runPass(options?: { background?: boolean; force?: boolean }): Promise<void> {
		// Captured BEFORE any await. cancel() aborts the current controller and installs a fresh one,
		// so reading `this.abortController` later would hand a pass that started before a cancel the
		// NEXT controller's signal — un-abortable, and in a headless run it would hold the task open
		// past its budget until the OS hard-kills it.
		const signal = this.abortController.signal

		if (this.locked) {
			return
		}

		const result = await run(async defer => {
			// Inside run(), not ahead of it: load() ends in publishMarked(), and a synchronous throw
			// from any store subscriber would otherwise escape sync() entirely — flipping an
			// otherwise-healthy background run to "failed". Also unconditional and ahead of the
			// connectivity gate, so an offline launch still renders the badges for marked notes.
			await this.load()

			await this.syncMutex.acquire()

			defer(() => {
				this.syncMutex.release()
			})

			if (signal.aborted || this.locked) {
				return
			}

			// Ahead of the connectivity gate and the empty-ledger exit: an un-mark can owe an
			// eviction from a session that ended before it could run, and reclaiming those bytes is
			// purely local work that a user sitting offline should still get.
			await this.drainPendingEvictions()

			if (!onlineManager.isOnline() || this.marked.size === 0) {
				return
			}

			// Automatic passes only. A background run bypasses the floor (it fires rarely and is the
			// one trigger that reaches a user who never opens the app while online), and so does a
			// `force` caller — reconnect. The floor exists to absorb `inactive -> active` flips; a
			// reconnect is the OPPOSITE of a spurious wake, because socket events are lost while
			// offline, so it is precisely when a pull is needed.
			if (
				options?.background !== true &&
				options?.force !== true &&
				this.lastCompletedPassAt !== null &&
				Date.now() - this.lastCompletedPassAt < AUTO_SYNC_MIN_INTERVAL_MS
			) {
				return
			}

			// Snapshotted BEFORE the list request. `plan.prune` deletes every marked uuid absent from
			// the response, and the marked map is live — so a note marked DURING the round trip (a
			// human-scale window on a large account) would otherwise be pruned moments later: body
			// evicted, ledger row deleted, badge gone, with no error and no trace of the user's tap.
			const markedAtPlanStart = new Set(this.marked.keys())

			const notes = await notesQueryFetch({
				signal
			})

			if (signal.aborted || this.locked) {
				return
			}

			const cachedUuids = new Set<string>()
			const openUuids = new Set<string>()

			for (const uuid of this.marked.keys()) {
				if (typeof noteContentQueryGet({ uuid }) === "string") {
					cachedUuids.add(uuid)
				}

				if (isNoteScreenOpen(uuid)) {
					openUuids.add(uuid)
				}
			}

			const plan = planNoteOfflineSync({
				marked: this.marked,
				notes,
				inflightUuids: await this.inflightUuidsIncludingPersisted(),
				cachedUuids,
				openUuids
			})

			for (const uuid of plan.prune) {
				if (!markedAtPlanStart.has(uuid)) {
					continue
				}

				// The note is gone from the account, so its body is dead weight regardless of whether
				// the user ever un-marked it. Evict first, then drop the row — same ordering rationale
				// as unmark().
				await this.evictContent(uuid)
				await this.deleteEntry(uuid)
			}

			// Stamped only for a pass that reached the end un-aborted. Stamping earlier armed the floor
			// from a pass the background deadline cancelled mid-fetch, suppressing the next 60s of
			// legitimate foreground passes — and measured the window from mid-pass, so a fetch loop
			// longer than the floor left the next trigger un-throttled entirely.
			const complete = (): void => {
				if (!signal.aborted && !this.locked) {
					this.lastCompletedPassAt = Date.now()
				}
			}

			if (plan.fetch.length === 0) {
				complete()

				return
			}

			logger.debug("notes-offline", "Sync pass fetching note bodies", {
				count: plan.fetch.length,
				pruned: plan.prune.length,
				background: options?.background === true
			})

			const byUuid = new Map<string, Note>()

			for (const note of notes) {
				byUuid.set(note.uuid, note)
			}

			await Promise.all(
				plan.fetch.map(async uuid => {
					const note = byUuid.get(uuid)

					if (!note) {
						return
					}

					await this.refreshSemaphore.acquire()

					try {
						if (signal.aborted || this.locked) {
							return
						}

						// Re-checked here rather than only in the plan: the user can open the note or
						// start typing during the pass, and the decision that matters is the one taken
						// closest to the write. The screen check mirrors the plan's exclusion so a note
						// opened after the plan was built is not downloaded only for commitContent to
						// discard it.
						if (
							inflightUuidSet().has(uuid) ||
							!this.marked.has(uuid) ||
							(isNoteScreenOpen(uuid) && typeof noteContentQueryGet({ uuid }) === "string")
						) {
							return
						}

						const observedBody = noteContentQueryGet({ uuid })
						const content = await getContent({ note, signal })

						if (signal.aborted || this.locked) {
							return
						}

						// Re-checked AFTER the round trip too. An un-mark landing while this note was
						// in flight would otherwise be undone: the body written back and the ledger
						// row re-created, badge and all.
						if (inflightUuidSet().has(uuid) || !this.marked.has(uuid)) {
							return
						}

						// Undecryptable body. Leave the ledger un-advanced (so this is retried) but
						// never cache a blank in place of content that exists.
						if (!isCacheableBody(content)) {
							logger.warn("notes-offline", "Marked note's body could not be decrypted; not caching a blank", {
								noteUuid: uuid
							})

							return
						}

						if (!this.commitContent({ uuid, content, observedBody })) {
							return
						}

						await this.writeEntry(
							uuid,
							{
								editedTimestamp: noteEditedStamp(note)
							},
							{
								requireExisting: true
							}
						)
					} catch (e) {
						if (signal.aborted) {
							return
						}

						// Ledger not advanced — the next pass retries this note.
						logger.warn("notes-offline", "Failed to fetch a marked note body", { noteUuid: uuid, error: e })
					} finally {
						this.refreshSemaphore.release()
					}
				})
			)

			complete()
		})

		if (!result.success && !signal.aborted) {
			logger.error("notes-offline", "Sync pass failed", { error: result.error })
		}

		// NO flush here. Bodies reach disk through the persister's debounce, and the background task
		// already defers an awaited queryClientPersisterKv.flushNow() that runs after this phase on
		// every exit path — so a flush here would be redundant, and worse: flushNow writes through
		// executeBatch, which bypasses sqlite's clearGeneration guard, so an un-gated flush unwinding
		// across logout would re-insert the previous account's decrypted bodies after the wipe.
		// (components/sync guards its own flush for exactly this reason.) mark() flushes explicitly
		// because it is a foreground action with no such deferred backstop.
	}

	/**
	 * Logout wipe. Bumps the generation, latches `locked`, and empties memory + the store projection.
	 * The kv rows die in the logout's global `DELETE FROM kv`; the latch exists because sqlite's
	 * clearGeneration only discards writes that STARTED before the wipe — a pass still unwinding
	 * afterwards would otherwise re-insert into the next account's ledger. The latch is permanent:
	 * logout ends in a bundle reload, which builds a fresh instance.
	 */
	public clearForLogout(): void {
		this.generation++
		this.locked = true

		this.cancel()

		this.marked.clear()
		this.refreshing.clear()

		this.loaded = false
		this.loadPromise = null
		this.inFlight = null
		this.lastCompletedPassAt = null

		useNotesOfflineStore.getState().setMarked({})
	}
}

const notesOffline = new NotesOffline()

export default notesOffline
