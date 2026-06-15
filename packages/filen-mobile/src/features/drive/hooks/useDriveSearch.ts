import { useState, useEffect, useRef } from "react"
import { AppState } from "react-native"
import { debounce } from "es-toolkit/function"
import { useIsFocused } from "expo-router"
import { CacheSearchResult_Tags, type CacheSearchResult, type CacheSearchSnapshot } from "@filen/sdk-rs"
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

function resultUuid(result: CacheSearchResult): string {
	return result.tag === CacheSearchResult_Tags.Dir ? result.inner.dir.uuid : result.inner.file.uuid
}

function mapResult(result: CacheSearchResult): DriveItem {
	return result.tag === CacheSearchResult_Tags.Dir
		? unwrappedDirIntoDriveItem(unwrapDirMeta(result.inner.dir))
		: unwrappedFileIntoDriveItem(unwrapFileMeta(result.inner.file))
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

	// Stable debounced re-filter (engine-local setConfig; no network, no re-open).
	const [debouncedSetName] = useState(() =>
		debounce((name: string) => {
			void driveSearch.setName(name)
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

		// Grace: give a freshly-opened search ~400ms before an empty result is allowed to
		// surface as "no results" (lets the convergence resync land first).
		const grace = setTimeout(() => {
			if (generation === generationRef.current) {
				setGraceElapsed(true)
			}
		}, GRACE_MS)

		// Watchdog: no first snapshot within this window -> terminal, so a wedged worker
		// can't spin "warming" forever.
		const watchdog = setTimeout(() => {
			if (generation === generationRef.current) {
				setWatchdogFired(true)
			}
		}, WATCHDOG_MS)

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
					}

					setSearchResults(next)
					setTotalCount(Number(snapshot.total))
					setLive(snapshot.live)
					setHasSnapshot(true)

					clearTimeout(watchdog)
				}
			})
			.catch(() => {
				if (generation === generationRef.current) {
					setOpenError(true)
				}
			})

		return () => {
			controller.abort()
			clearTimeout(grace)
			clearTimeout(watchdog)

			// Background close is the singleton's (it releases the worker's socket listener so
			// the WS can close); closing here too would race it. Only close on a real
			// screen-leave / tab-blur / query-clear / unmount (app still active).
			if (AppState.currentState === "active") {
				void driveSearch.closeActive()
			}
		}
	}, [isCacheSearch, isFocused, isAppActive, biometricUnlocked, drivePath.uuid, reopenNonce])

	// Effect B — debounced re-filter on query change (no re-open).
	useEffect(() => {
		if (!isCacheSearch) {
			return
		}

		debouncedSetName(searchQuery)
	}, [searchQuery, isCacheSearch, debouncedSetName])

	// Stall ceiling — a dropped `Finished` must not pin "Still searching…" forever. The
	// reset (on `resyncing` toggling) is the render-phase block above; this only ARMS.
	// Generation-guarded: this effect's deps are [resyncing], so if `resyncing` stays true
	// across a session change (Effect A reopens + bumps the generation), this effect does
	// NOT re-run and its old timer keeps counting. Capturing the generation at arm time and
	// checking it in the callback stops a stale timer from collapsing the new session.
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
	}, [resyncing])

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
		(input.watchdogFired && !input.hasSnapshot)
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
