import { useState, useEffect, useRef } from "react"
import { AppState } from "react-native"
import { debounce } from "es-toolkit/function"
import { useIsFocused } from "expo-router"
import { CacheSearchResult_Tags, DirColor_Tags, DirMeta_Tags, FileMeta_Tags, type CacheSearchHit, type CacheSearchSnapshot } from "@filen/sdk-rs"
import { type DriveItem } from "@/types"
import { type DrivePath } from "@/hooks/useDrivePath"
import driveSearch from "@/features/drive/driveSearch"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"
import { useDriveStore } from "@/features/drive/store/useDrive.store"
import { unwrapDirMeta, unwrappedDirIntoDriveItem, unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import events from "@/lib/events"
import useIsOnline from "@/hooks/useIsOnline"
import useIsAppActive from "@/hooks/useIsAppActive"
import { useAppStore } from "@/stores/useApp.store"
import logger from "@/lib/logger"
import { type DriveSearchStatus, deriveStatus, isOnlineComplete } from "@/features/drive/hooks/driveSearchStatus"

export type { DriveSearchStatus }

export type UseDriveSearch = {
	searchQuery: string
	setSearchQuery: React.Dispatch<React.SetStateAction<string>>
	searchResults: DriveItem[]
	// uuid -> parent path relative to the search root, for the search list's path sub-row.
	searchResultPaths: Map<string, string>
	status: DriveSearchStatus
	// Total match count reported by the SDK (may exceed `searchResults.length`, which is
	// capped at the window CEILING) — drives the "showing first N of M" truncation footer.
	totalCount: number
}

const SETCONFIG_DEBOUNCE_MS = 350
// Never flash "no results" within this window of a (re)filter — covers the gap between
// the search opening / the query changing and the first matching snapshot landing.
const GRACE_MS = 400
// No first snapshot within this window of opening -> treat as terminal ("Search
// unavailable") so a wedged worker can't spin "Searching…" forever.
const WATCHDOG_MS = 15_000
// Backstop for a dropped `Finished`: stop showing "Still searching…" after this long.
const STALL_CEILING_MS = 30_000

// Stable empties returned while results are hidden (warming / terminal) — avoids allocating a fresh
// array + Map every render in those states.
const NO_RESULTS: DriveItem[] = []
const NO_PATHS = new Map<string, string>()

function resultUuid(hit: CacheSearchHit): string {
	return hit.result.tag === CacheSearchResult_Tags.Dir ? hit.result.inner.dir.uuid : hit.result.inner.file.uuid
}

function mapResult(hit: CacheSearchHit): DriveItem {
	return hit.result.tag === CacheSearchResult_Tags.Dir
		? unwrappedDirIntoDriveItem(unwrapDirMeta(hit.result.inner.dir))
		: unwrappedFileIntoDriveItem(unwrapFileMeta(hit.result.inner.file))
}

// Cheap content signature of a hit, keying the per-uuid map cache so an item is RE-mapped when any
// DISPLAYED field changed remotely. The SDK window re-delivers a hit (same uuid) whenever its
// CacheableDir/File changes (favorited / color / name all part of its derived PartialEq), but a
// name-only signature would reuse the stale cached object on a favorite/color change that keeps the
// name — so fold in `favorited` (dir + file) and `color` (dir, incl. the custom hex). The `d:`/`f:`
// prefix keeps a real signature distinct from a missing-meta "".
function resultSignature(hit: CacheSearchHit): string {
	if (hit.result.tag === CacheSearchResult_Tags.Dir) {
		const dir = hit.result.inner.dir
		const name = dir.meta?.tag === DirMeta_Tags.Decoded ? dir.meta.inner[0].name : ""
		const color = dir.color.tag === DirColor_Tags.Custom ? `Custom:${dir.color.inner[0]}` : dir.color.tag

		return `d:${name}:${color}:${dir.favorited ? "1" : "0"}`
	}

	const file = hit.result.inner.file
	const name = file.meta?.tag === FileMeta_Tags.Decoded ? file.meta.inner[0].name : ""

	return `f:${name}:${file.favorited ? "1" : "0"}`
}

/**
 * Owns Drive's search state: the query string plus the cache-backed search results that
 * REPLACE the directory listing while a query is active (single source — the merge with
 * `findItemMatchesForName` is gone). Drives a grace-gated status machine (see
 * `DriveSearchStatus`) so the UI never flashes "no results" while results are still
 * streaming in from the convergence resync.
 *
 * Lifecycle: cache search runs ONLY on the plain `/drive` browser (not the
 * favorites/trash/select variants, which keep their local filter). The search opens when
 * the query is non-empty AND the screen is focused AND the app is active AND biometric is
 * unlocked; it closes on screen-leave / tab-blur / query-clear / unmount. Background close
 * is owned by the `driveSearch` singleton (this effect's cleanup skips it when the app is
 * backgrounding), so `isAppActive` is purely an open-gate — the foreground edge re-opens.
 */
export function useDriveSearch({ drivePath }: { drivePath: DrivePath }): UseDriveSearch {
	const [searchQuery, setSearchQuery] = useState<string>("")
	const [searchResults, setSearchResults] = useState<DriveItem[]>([])
	// uuid -> the hit's parent path relative to the search root (cache search only); drives the
	// path sub-row in the drive search list. Rebuilt from each snapshot.
	const [searchResultPaths, setSearchResultPaths] = useState<Map<string, string>>(() => new Map<string, string>())
	const [totalCount, setTotalCount] = useState<number>(0)
	const [live, setLive] = useState<boolean>(true)
	const [hasSnapshot, setHasSnapshot] = useState<boolean>(false)
	const [graceElapsed, setGraceElapsed] = useState<boolean>(false)
	const [watchdogFired, setWatchdogFired] = useState<boolean>(false)
	const [stallCeilingHit, setStallCeilingHit] = useState<boolean>(false)
	const [openError, setOpenError] = useState<boolean>(false)
	const [reopenNonce, setReopenNonce] = useState<number>(0)
	// The query whose results are currently ON DISPLAY (the last snapshot the hook accepted, or the
	// last filter the engine accepted for an identical-window setName). Render-readable so the
	// per-query reset below can tell a retype of the SAME displayed term (keep results — the warm
	// engine suppresses the identical snapshot) from a DIFFERENT term (reset to warming).
	const [appliedQuery, setAppliedQuery] = useState<string>("")

	const resyncing = useDriveSearchStore(state => state.resyncing)
	const rootDeleted = useDriveSearchStore(state => state.rootDeleted)
	const cacheUnavailable = useDriveSearchStore(state => state.cacheUnavailable)
	const resyncProgress = useDriveSearchStore(state => state.resyncProgress)
	const isOnline = useIsOnline()
	const isAppActive = useIsAppActive()
	const isFocused = useIsFocused()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)

	const isPlainDrive = drivePath.type === "drive" && !drivePath.selectOptions
	const searchActive = searchQuery.trim().length > 0
	const isCacheSearch = isPlainDrive && searchActive

	// Identity of the current search session — changes whenever the open effect must (re)open: the
	// plain-drive gate flips, the target directory changes, or a connectivity-restore reopen bumps
	// the nonce. The query TEXT and its empty/non-empty state are deliberately excluded — keystrokes
	// refilter in place via setName, and clearing to blank must NOT change the session (the engine
	// stays warm; see `searchEngaged` below).
	const sessionKey = `${isPlainDrive ? "plain" : "off"}:${drivePath.type ?? ""}:${drivePath.uuid ?? ""}:${reopenNonce}`

	// Once a query has been entered this session, keep the SDK search engine OPEN even after the
	// query is cleared to blank — so clearing + retyping is an in-engine refilter (setName), never a
	// teardown + convergence-resync restart. The latch is keyed to the session, so it resets when
	// the folder / nonce / plain-drive gate changes, but NOT when the query text toggles. The DISPLAY
	// and status stay gated on `isCacheSearch` (blank → the directory listing); only the engine
	// lifecycle (Effect A) uses `searchEngaged`.
	const [engagedSessionKey, setEngagedSessionKey] = useState<string | null>(searchActive ? sessionKey : null)

	if (searchActive && engagedSessionKey !== sessionKey) {
		setEngagedSessionKey(sessionKey)
	}

	const searchEngaged = isPlainDrive && engagedSessionKey === sessionKey

	// Render-phase reset (React's documented "adjust state while rendering" pattern — NOT
	// an effect, so it triggers no cascading-render lint): the instant the session identity
	// changes, clear the per-session display + timer-flag state BEFORE the open effect runs,
	// so a reopen never paints the previous search's rows.
	const [activeSessionKey, setActiveSessionKey] = useState<string>(sessionKey)

	if (sessionKey !== activeSessionKey) {
		setActiveSessionKey(sessionKey)
		setSearchResults([])
		setSearchResultPaths(new Map<string, string>())
		setTotalCount(0)
		setLive(true)
		setHasSnapshot(false)
		setGraceElapsed(false)
		setWatchdogFired(false)
		setStallCeilingHit(false)
		setOpenError(false)
		setAppliedQuery("")
	}

	// Per-query reset. The display is gated on `status` in the return (results are hidden while
	// warming/terminal), so a query change need only flip the session into "warming" — it must NOT
	// clear the results STATE (that would strand a clear→retype of the SAME term, whose warm-engine
	// snapshot the SDK suppresses, leaving nothing to repaint it). Reset to warming ONLY when the
	// active query differs from the one on display (`appliedQuery`): never on a clear to blank (the
	// blank view is the directory listing; the results stay cached for an instant retype) and never
	// on a same-term retype (resetting hasSnapshot there would strand the watchdog → false
	// "Search unavailable", since the suppressed snapshot never flips it back). Render-phase,
	// mirroring the session reset above. Also drops the sticky terminal flags so a prior query's
	// wedge/error/stall doesn't flash onto the new term.
	const [prevQueryNorm, setPrevQueryNorm] = useState<string>(searchQuery.trim())

	if (searchQuery.trim() !== prevQueryNorm) {
		setPrevQueryNorm(searchQuery.trim())

		if (searchActive && searchQuery.trim() !== appliedQuery) {
			setHasSnapshot(false)
			setWatchdogFired(false)
			setStallCeilingHit(false)
			setOpenError(false)
		}
	}

	// Reset the stall ceiling whenever the worker-global resync flag toggles, so each
	// resync gets a fresh stall window (render-phase, keyed on `resyncing`).
	const [prevResyncing, setPrevResyncing] = useState<boolean>(resyncing)

	if (resyncing !== prevResyncing) {
		setPrevResyncing(resyncing)
		setStallCeilingHit(false)
	}

	// Clear the watchdog latch on the re-arm edges `sessionKey` excludes — the open-gate
	// flips (focus/foreground/unlock) and every resync-progress heartbeat. Otherwise a sticky
	// `watchdogFired` would mis-report "terminal" on a search that re-opened or resumed
	// progressing (e.g. Listing ticks after a dropped Started). The watchdog effect can't
	// setState synchronously (lint); this render-phase reset is the equivalent. (sessionKey
	// changes — uuid / reopenNonce / on-off — already clear it via the block above.)
	const watchdogRearmKey = `${isFocused}:${isAppActive}:${String(biometricUnlocked)}:${resyncProgress}`
	const [prevWatchdogRearmKey, setPrevWatchdogRearmKey] = useState<string>(watchdogRearmKey)

	if (watchdogRearmKey !== prevWatchdogRearmKey) {
		setPrevWatchdogRearmKey(watchdogRearmKey)
		setWatchdogFired(false)
	}

	// Re-arm the GRACE on every resync sign-of-life (a `Started`/`Finished` edge or a `Listing`
	// heartbeat), mirroring the watchdog/stall-ceiling. So `graceElapsed` means "GRACE_MS of QUIET
	// since open or the last resync activity", not "GRACE_MS since open" — an empty result can't
	// then flash "no results" during a transient `!resyncing` gap while the convergence resync is
	// still streaming results in (e.g. `Finished` landing a beat before the final snapshot).
	const graceRearmKey = `${resyncProgress}:${String(resyncing)}`
	const [prevGraceRearmKey, setPrevGraceRearmKey] = useState<string>(graceRearmKey)

	if (graceRearmKey !== prevGraceRearmKey) {
		setPrevGraceRearmKey(graceRearmKey)
		setGraceElapsed(false)
	}

	// Imperative state that must NOT re-run the open effect: the live query (read at open
	// time — synced in an effect below, since a render-phase ref write is illegal), the
	// per-search generation, the removal tombstones (cleared only on an own restore/update
	// event — never on snapshot membership, or a trash would resurrect before the worker
	// drops it), the uuid -> {sig, DriveItem} memo (re-map only NEW or content-CHANGED results —
	// onSnapshot re-fires the full window; the signature catches a remote rename that keeps the
	// uuid), and the last-seen online flag (for the connectivity-restore reopen).
	const searchQueryRef = useRef<string>(searchQuery)
	// The filter the SDK engine currently holds — the last name the hook ISSUED via open / setName.
	// Set in callbacks/effects (never render). Read in onSnapshot to reject a snapshot for a
	// SUPERSEDED filter (a live update for the prior term arriving in the debounce gap before the
	// new setName lands) so it isn't painted under the new query.
	const lastIssuedNameRef = useRef<string>("")
	const generationRef = useRef<number>(0)
	// Whether the CURRENT open has delivered at least one snapshot. A setName the engine accepts
	// proves liveness only for an ALREADY-established search (so an identical-window refilter whose
	// snapshot the SDK suppresses doesn't strand the watchdog); for a never-delivered (wedged) open
	// it must NOT fake hydration — the watchdog still has to fire terminal. Reset per open.
	const everDeliveredSnapshotRef = useRef<boolean>(false)
	// Bumped on every ACCEPTED snapshot. Lets a setName's resolution tell whether the engine emitted
	// a fresh snapshot (seq moved → onSnapshot already applied the new window) or SUPPRESSED an
	// identical one (seq unchanged → setName must hydrate, else it wedges). Stops a results-changing
	// refilter from briefly painting the prior term's rows if setName resolves before its snapshot.
	const snapshotSeqRef = useRef<number>(0)
	const tombstonesRef = useRef<Set<string>>(new Set<string>())
	const mapCacheRef = useRef<Map<string, { sig: string; item: DriveItem }>>(new Map<string, { sig: string; item: DriveItem }>())
	const wasOnlineRef = useRef<boolean>(isOnline)

	// Keep the latest query in a ref WITHOUT making it an open-effect dependency (a keystroke
	// must refilter via setName, never reopen). Synced in an effect — declared before the
	// open effect, so the ref is current when the open effect reads it on the same commit.
	useEffect(() => {
		searchQueryRef.current = searchQuery
	}, [searchQuery])

	// Stable debounced re-filter (engine-local setConfig; no network, no re-open). If the
	// search is no longer live (closed on backgrounding and not reopened, or the handle went
	// stale), setName returns false and we REOPEN via the passed callback — otherwise a
	// keystroke after a background→foreground cycle would silently no-op forever (the search
	// was torn down to release the shared socket, and refilter alone can't bring it back).
	// Stable debounced re-filter (engine-local setConfig; no network, no re-open). Created in an
	// effect — not a render-phase useState initializer — so it may read refs (lastIssuedNameRef /
	// everDeliveredSnapshotRef), which a render-created closure must not. If the engine has no live
	// search (setName → false: closed on backgrounding and not reopened) we REOPEN via the nonce,
	// so a keystroke after a background→foreground cycle can't silently no-op into a closed search.
	const debouncedSetNameRef = useRef<((name: string) => void) | null>(null)

	useEffect(() => {
		const fn = debounce((name: string) => {
			// The engine's filter is becoming this name. Recorded SYNCHRONOUSLY (before the await) so
			// onSnapshot's stale-filter guard sees the right value for a live update in the gap.
			lastIssuedNameRef.current = name.trim()

			const seqAtIssue = snapshotSeqRef.current

			void driveSearch.setName(name).then(applied => {
				if (!applied) {
					setReopenNonce(nonce => nonce + 1)

					return
				}

				setAppliedQuery(name.trim())

				// Force-hydrate ONLY when the engine SUPPRESSED the snapshot — no accepted snapshot
				// since we issued this setName (seq unchanged) — AND this open already delivered once.
				// That covers a clear→retype of the same or another identically-empty term (the SDK
				// emits nothing, so without this the watchdog would wedge an alive search at "Search
				// unavailable"). If a fresh snapshot DID land (seq moved) onSnapshot already applied
				// the correct window — don't pre-empt it with the prior term's rows. A never-delivered
				// (wedged) open stays un-hydrated so the watchdog can still fire terminal. Clearing the
				// terminal flags is safe regardless: the engine answered, so it is alive.
				if (everDeliveredSnapshotRef.current && snapshotSeqRef.current === seqAtIssue) {
					setHasSnapshot(true)
				}

				setOpenError(false)
				setWatchdogFired(false)
			})
		}, SETCONFIG_DEBOUNCE_MS)

		debouncedSetNameRef.current = fn

		return () => {
			fn.cancel()
		}
	}, [])

	// Effect A — open / close + the per-session grace & watchdog timers. Their setState
	// fires from timer / snapshot callbacks (allowed), never synchronously — the per-session
	// reset is the render-phase block above. isAppActive is an OPEN-gate; background close is
	// the singleton's job, so the cleanup skips close while the app is backgrounding.
	useEffect(() => {
		if (!searchEngaged || !isFocused || !isAppActive || biometricUnlocked !== true) {
			return
		}

		// `searchEngaged` latches across a query-clear so the engine stays warm for an instant
		// retype — but a (re)open edge (foreground / focus / unlock) reached with a BLANK query (the
		// user cleared and left) must NOT spin up a match-everything search: that re-acquires the
		// worker socket and runs a pointless subtree resync. Read via the ref (NOT a dep, so a
		// clear/retype never re-runs this effect); a retype-after-clear recovers via setName → reopen.
		if (searchQueryRef.current.trim().length === 0) {
			return
		}

		// The engine's filter is becoming this name (mirrors debouncedSetName) — recorded before any
		// await so onSnapshot's stale-filter guard sees the right value for the initial window.
		lastIssuedNameRef.current = searchQueryRef.current.trim()

		const generation = ++generationRef.current

		everDeliveredSnapshotRef.current = false
		tombstonesRef.current = new Set<string>()
		mapCacheRef.current = new Map<string, { sig: string; item: DriveItem }>()

		const controller = new AbortController()

		driveSearch
			.open({
				rootUuid: drivePath.uuid,
				name: searchQueryRef.current,
				signal: controller.signal,
				onSnapshot: (snapshot: CacheSearchSnapshot) => {
					if (generation !== generationRef.current) {
						return
					}

					// Reject a snapshot for a SUPERSEDED filter: while a query change waits for its
					// debounced setName, the engine still holds the OLD filter and may emit live
					// updates for it — painting those under the new query is the stale-row flash.
					// lastIssuedNameRef is the engine's current filter; only paint once it matches
					// the live query (the new setName has landed). The initial open sets the ref to
					// the open name before this fires, so the first window is never rejected.
					if (lastIssuedNameRef.current !== searchQueryRef.current.trim()) {
						return
					}

					const memo = mapCacheRef.current
					const tombstones = tombstonesRef.current
					const next: DriveItem[] = []
					const nextPaths = new Map<string, string>()

					for (const result of snapshot.results) {
						const uuid = resultUuid(result)

						if (tombstones.has(uuid)) {
							continue
						}

						const sig = resultSignature(result)
						const cached = memo.get(uuid)
						let item: DriveItem

						// Reuse the cached object ONLY while the content signature matches (stable ref
						// for FlashList); a remote rename keeps the uuid but changes the signature, so
						// re-map it instead of rendering the stale name.
						if (cached && cached.sig === sig) {
							item = cached.item
						} else {
							item = mapResult(result)

							memo.set(uuid, { sig, item })
						}

						next.push(item)
						nextPaths.set(uuid, result.parentPath)
					}

					setSearchResults(next)
					setSearchResultPaths(nextPaths)
					setTotalCount(Number(snapshot.total))
					setLive(snapshot.live)
					setHasSnapshot(true)
					everDeliveredSnapshotRef.current = true
					snapshotSeqRef.current += 1
					// A snapshot landed → this (re)open succeeded, so drop any prior open error (a
					// failed foreground reopen sets it; a later success must self-heal). Record the
					// displayed query so the per-query reset can recognise a same-term retype.
					setOpenError(false)
					setAppliedQuery(lastIssuedNameRef.current)
				}
			})
			.catch((error: unknown) => {
				if (generation === generationRef.current) {
					logger.error("drive-search", "search open failed", { error: error, rootUuid: drivePath.uuid })
					setOpenError(true)
				}
			})

		return () => {
			controller.abort()

			// Background close is the singleton's (it releases the worker's socket listener so
			// the WS can close); closing here too would race it. Only close on a real session
			// teardown — screen-leave / tab-blur / directory change / unmount (app still active).
			// A query-clear does NOT reach here: `searchEngaged` stays true across a blank query, so
			// Effect A doesn't re-run and the engine stays warm.
			if (AppState.currentState === "active") {
				void driveSearch.closeActive()
			}
		}
	}, [searchEngaged, isFocused, isAppActive, biometricUnlocked, drivePath.uuid, reopenNonce])

	// Grace timer — re-armed (cleared + restarted) on every resync sign-of-life via its
	// `resyncProgress`/`resyncing` deps (the render-phase block above resets the latch on the same
	// edges). So `graceElapsed` fires only after GRACE_MS of true quiet, never mid-stream. Unlike
	// the watchdog there's NO `hasSnapshot` guard: an EMPTY first snapshot must still be graced
	// before it can surface as "no results".
	useEffect(() => {
		if (!isCacheSearch || !isFocused || !isAppActive || biometricUnlocked !== true) {
			return
		}

		const generation = generationRef.current

		const grace = setTimeout(() => {
			if (generation === generationRef.current) {
				setGraceElapsed(true)
			}
		}, GRACE_MS)

		return () => {
			clearTimeout(grace)
		}
	}, [isCacheSearch, isFocused, isAppActive, biometricUnlocked, drivePath.uuid, reopenNonce, resyncProgress, resyncing])

	// Watchdog — terminal "no sign of life". Re-arms on open AND on every resync-progress
	// heartbeat (`resyncProgress`), so it measures SILENCE, not total elapsed time: a slow
	// search that's actively listing (Listing ticks ~every 200ms) keeps pushing it out and
	// never false-fails. Inert once a snapshot has landed (`hasSnapshot` guard + dep). Only
	// fires when nothing — no snapshot, no progress — happened for the whole window.
	useEffect(() => {
		// Arm ONLY while the search is actually open — mirror Effect A's open-gates. Without
		// the gates here, Effect A re-opens (bumping the generation) on a focus/foreground/
		// unlock edge while this effect (which lacked those deps) didn't re-run, so the
		// re-opened generation got NO watchdog and a wedged re-open span "warming" forever.
		if (!isCacheSearch || !isFocused || !isAppActive || biometricUnlocked !== true || hasSnapshot) {
			return
		}

		const generation = generationRef.current

		const watchdog = setTimeout(() => {
			if (generation === generationRef.current) {
				setWatchdogFired(true)
			}
		}, WATCHDOG_MS)

		return () => {
			clearTimeout(watchdog)
		}
	}, [isCacheSearch, isFocused, isAppActive, biometricUnlocked, hasSnapshot, drivePath.uuid, reopenNonce, resyncProgress])

	// Effect B — debounced re-filter on query change. Reopens (bumps the nonce → Effect A)
	// if the refilter finds no live search, so typing after a background→foreground cycle
	// recovers instead of no-opping.
	useEffect(() => {
		if (!isCacheSearch) {
			return
		}

		debouncedSetNameRef.current?.(searchQuery)
	}, [searchQuery, isCacheSearch])

	// Stall ceiling — backstop for a dropped `Finished` (best-effort delivery) so a stuck
	// `resyncing` can't pin "Still searching…" forever. Re-arms on `resyncProgress` (every
	// Listing/Applying heartbeat) so it measures SILENCE since the last sign of life, NOT
	// total resync duration: a legitimately long search streaming Listing ticks (~every
	// 200ms) keeps resetting it and never false-collapses to "no results"/settled. It only
	// fires after a full window of total silence (a dropped Finished, or the rare silent
	// >window `Applying` phase). Generation-guarded: if `resyncing` stays true across a
	// session change (Effect A reopens + bumps the generation) this effect's old timer keeps
	// counting, so the captured-generation check stops it collapsing the new session.
	useEffect(() => {
		if (!resyncing) {
			return
		}

		const generation = generationRef.current

		const timer = setTimeout(() => {
			if (generation === generationRef.current) {
				setStallCeilingHit(true)
			}
		}, STALL_CEILING_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [resyncing, resyncProgress])

	// Offline -> online while incomplete: re-open (the uncached resync can now complete).
	// Conditional (guarded by the transition) — not a synchronous effect-body setState.
	useEffect(() => {
		const wasOnline = wasOnlineRef.current

		wasOnlineRef.current = isOnline

		if (!wasOnline && isOnline && isCacheSearch && !isOnlineComplete(hasSnapshot, totalCount)) {
			setReopenNonce(nonce => nonce + 1)
		}
	}, [isOnline, isCacheSearch, hasSnapshot, totalCount])

	// Effect D — optimistic patch for the user's OWN actions (the live list otherwise
	// only self-heals on the next snapshot). Removals tombstone + drop + purge selection;
	// updates replace by previousUuid (and clear any tombstone, so an own restore reappears).
	useEffect(() => {
		if (!isPlainDrive) {
			return
		}

		const removedSub = events.subscribe("driveItemRemoved", ({ uuid }) => {
			tombstonesRef.current.add(uuid)
			mapCacheRef.current.delete(uuid)

			setSearchResults(prev => prev.filter(item => item.data.uuid !== uuid))

			useDriveStore.getState().removeFromSelection([uuid])
		})

		const updatedSub = events.subscribe("driveItemUpdated", ({ previousUuid, item }) => {
			tombstonesRef.current.delete(previousUuid)
			tombstonesRef.current.delete(item.data.uuid)
			mapCacheRef.current.delete(previousUuid)
			// Drop the cache entry (don't store the optimistic item) so the next snapshot re-maps
			// from the authoritative hit — the memo holds {sig, item}, not a bare DriveItem.
			mapCacheRef.current.delete(item.data.uuid)

			setSearchResults(prev => {
				const wasPresent = prev.some(existing => existing.data.uuid === previousUuid || existing.data.uuid === item.data.uuid)

				if (!wasPresent) {
					return prev
				}

				const without = prev.filter(existing => existing.data.uuid !== previousUuid && existing.data.uuid !== item.data.uuid)

				return [...without, item]
			})
		})

		return () => {
			removedSub.remove()
			updatedSub.remove()
		}
	}, [isPlainDrive])

	// Purge selected items that left the visible result set — a query refinement that narrowed the
	// matches, or a remote rename / move that dropped a hit. Otherwise a bulk action would target
	// now-hidden items and the header's select-all count would desync from what's on screen. Gated
	// on `hasSnapshot` so it reconciles against a real result set, never a transiently-stale one
	// mid-warming. Mirrors the sharedIn purge in the Drive component.
	useEffect(() => {
		if (!isCacheSearch || !hasSnapshot) {
			return
		}

		const present = new Set(searchResults.map(item => item.data.uuid))
		const selected = useDriveStore.getState().selectedItems
		const stale = selected.filter(item => !present.has(item.data.uuid)).map(item => item.data.uuid)

		if (stale.length > 0) {
			useDriveStore.getState().removeFromSelection(stale)
		}
	}, [searchResults, isCacheSearch, hasSnapshot])

	const status = deriveStatus({
		isCacheSearch,
		live,
		openError,
		cacheUnavailable,
		rootDeleted,
		watchdogFired,
		hasSnapshot,
		isOnline,
		totalCount,
		resyncing,
		graceElapsed,
		stallCeilingHit
	})

	// Hide the result STATE while warming (a query change in flight) or terminal (a failed open):
	// the loading spinner is a transparent overlay, so leaking the prior term's rows under it is the
	// stale-row flash, and a terminal must show its empty state, not stale rows. The state itself is
	// retained (never cleared on a query change) so a same-term retype repaints instantly once
	// `status` leaves warming. settled / background / searching-empty / offline-incomplete show the
	// real results (empty ones are already []).
	const showResults = status !== "warming" && status !== "terminal"

	return {
		searchQuery,
		setSearchQuery,
		searchResults: showResults ? searchResults : NO_RESULTS,
		searchResultPaths: showResults ? searchResultPaths : NO_PATHS,
		status,
		totalCount: showResults ? totalCount : 0
	}
}

export default useDriveSearch
