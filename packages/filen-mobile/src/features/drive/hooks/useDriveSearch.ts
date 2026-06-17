import { useState, useEffect, useRef } from "react"
import { AppState } from "react-native"
import { debounce } from "es-toolkit/function"
import { useIsFocused } from "expo-router"
import { CacheSearchResult_Tags, type CacheSearchHit, type CacheSearchSnapshot } from "@filen/sdk-rs"
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

export type DriveSearchStatus = "idle" | "warming" | "background" | "settled" | "terminal" | "offline-incomplete"

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

function resultUuid(hit: CacheSearchHit): string {
	return hit.result.tag === CacheSearchResult_Tags.Dir ? hit.result.inner.dir.uuid : hit.result.inner.file.uuid
}

function mapResult(hit: CacheSearchHit): DriveItem {
	return hit.result.tag === CacheSearchResult_Tags.Dir
		? unwrappedDirIntoDriveItem(unwrapDirMeta(hit.result.inner.dir))
		: unwrappedFileIntoDriveItem(unwrapFileMeta(hit.result.inner.file))
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

	// Identity of the current search session — changes whenever the open effect must
	// (re)open: the cache-search gate flips, the target directory changes, or a
	// connectivity-restore reopen bumps the nonce. The query TEXT is deliberately excluded
	// (keystrokes refilter in place via setName, never reopen).
	const sessionKey = `${isCacheSearch ? "on" : "off"}:${drivePath.type ?? ""}:${drivePath.uuid ?? ""}:${reopenNonce}`

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
	// drops it), the uuid -> DriveItem memo (map only NEW results — onSnapshot re-fires the
	// full window), and the last-seen online flag (for the connectivity-restore reopen).
	const searchQueryRef = useRef<string>(searchQuery)
	const generationRef = useRef<number>(0)
	const tombstonesRef = useRef<Set<string>>(new Set<string>())
	const mapCacheRef = useRef<Map<string, DriveItem>>(new Map<string, DriveItem>())
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
	const [debouncedSetName] = useState(() =>
		debounce((name: string, reopen: () => void) => {
			void driveSearch.setName(name).then(applied => {
				if (!applied) {
					reopen()
				}
			})
		}, SETCONFIG_DEBOUNCE_MS)
	)

	// Effect A — open / close + the per-session grace & watchdog timers. Their setState
	// fires from timer / snapshot callbacks (allowed), never synchronously — the per-session
	// reset is the render-phase block above. isAppActive is an OPEN-gate; background close is
	// the singleton's job, so the cleanup skips close while the app is backgrounding.
	useEffect(() => {
		if (!isCacheSearch || !isFocused || !isAppActive || biometricUnlocked !== true) {
			return
		}

		const generation = ++generationRef.current

		tombstonesRef.current = new Set<string>()
		mapCacheRef.current = new Map<string, DriveItem>()

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

					const memo = mapCacheRef.current
					const tombstones = tombstonesRef.current
					const next: DriveItem[] = []
					const nextPaths = new Map<string, string>()

					for (const result of snapshot.results) {
						const uuid = resultUuid(result)

						if (tombstones.has(uuid)) {
							continue
						}

						let item = memo.get(uuid)

						if (!item) {
							item = mapResult(result)

							memo.set(uuid, item)
						}

						next.push(item)
						nextPaths.set(uuid, result.parentPath)
					}

					setSearchResults(next)
					setSearchResultPaths(nextPaths)
					setTotalCount(Number(snapshot.total))
					setLive(snapshot.live)
					setHasSnapshot(true)
				}
			})
			.catch(() => {
				if (generation === generationRef.current) {
					setOpenError(true)
				}
			})

		return () => {
			controller.abort()

			// Background close is the singleton's (it releases the worker's socket listener so
			// the WS can close); closing here too would race it. Only close on a real
			// screen-leave / tab-blur / query-clear / unmount (app still active).
			if (AppState.currentState === "active") {
				void driveSearch.closeActive()
			}
		}
	}, [isCacheSearch, isFocused, isAppActive, biometricUnlocked, drivePath.uuid, reopenNonce])

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

		debouncedSetName(searchQuery, () => setReopenNonce(nonce => nonce + 1))
	}, [searchQuery, isCacheSearch, debouncedSetName])

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
			mapCacheRef.current.set(item.data.uuid, item)

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

	return {
		searchQuery,
		setSearchQuery,
		searchResults,
		searchResultPaths,
		status,
		totalCount
	}
}

function isOnlineComplete(hasSnapshot: boolean, totalCount: number): boolean {
	return hasSnapshot && totalCount > 0
}

function deriveStatus(input: {
	isCacheSearch: boolean
	live: boolean
	openError: boolean
	cacheUnavailable: boolean
	rootDeleted: boolean
	watchdogFired: boolean
	hasSnapshot: boolean
	isOnline: boolean
	totalCount: number
	resyncing: boolean
	graceElapsed: boolean
	stallCeilingHit: boolean
}): DriveSearchStatus {
	if (!input.isCacheSearch) {
		return "idle"
	}

	if (
		!input.live ||
		// `!hasSnapshot`-guarded like watchdogFired: openError is sticky session state NOT in
		// sessionKey, so a foreground/focus/unlock re-open re-runs Effect A without clearing
		// it. Without this guard a single failed open would wedge the session in "terminal"
		// forever even after a successful re-open delivers results. Self-heals on first snapshot.
		(input.openError && !input.hasSnapshot) ||
		input.cacheUnavailable ||
		input.rootDeleted ||
		// `&& !resyncing`: a watchdog fire during an active resync (Started arrived, worker
		// alive) is not a wedge — stay warming. The watchdog effect also resets on every
		// progress heartbeat, so this mainly covers a brief tick gap after Started.
		(input.watchdogFired && !input.hasSnapshot && !input.resyncing)
	) {
		return "terminal"
	}

	if (!input.isOnline && input.totalCount === 0) {
		return "offline-incomplete"
	}

	// Warming: no snapshot yet, OR an empty result that may still fill in — kept warming
	// while a resync is in flight OR within the grace window, unless the stall ceiling tripped.
	if (!input.hasSnapshot || (input.totalCount === 0 && (input.resyncing || !input.graceElapsed) && !input.stallCeilingHit)) {
		return "warming"
	}

	if (input.totalCount > 0 && input.resyncing && !input.stallCeilingHit) {
		return "background"
	}

	return "settled"
}

export default useDriveSearch
