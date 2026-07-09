import { useEffect, useRef, useState } from "react"
import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { type DriveItem } from "@/lib/drive/item"
import {
	deriveSearchStatus,
	GRACE_MS,
	WATCHDOG_MS,
	STALL_CEILING_MS,
	SETCONFIG_DEBOUNCE_MS,
	type SearchStatus
} from "@/lib/drive/search-status.logic"
import { type SearchPush, type SearchHitDTO } from "@/workers/search-engine"
import { buildSearchResults, resolveSearchTransition } from "@/components/drive/use-drive-search.logic"

export interface UseDriveSearchResult {
	input: string
	setInput: (value: string) => void
	active: boolean
	results: DriveItem[]
	parentPaths: ReadonlyMap<string, string>
	total: bigint
	status: SearchStatus
	clear: () => void
}

interface SearchPushState {
	hits: SearchHitDTO[]
	total: bigint
	live: boolean
	resyncing: boolean
	rootDeleted: boolean
	hasSnapshot: boolean
}

const INITIAL_PUSH_STATE: SearchPushState = { hits: [], total: 0n, live: true, resyncing: false, rootDeleted: false, hasSnapshot: false }

// The engine's supersede rejection is expected on every reopen/retune race, never a genuine failure —
// see search-engine.ts's own SearchSupersededError doc comment. Never `instanceof
// SearchSupersededError` or `.name`: verified live (see the smoke evidence) that no worker-thrown
// value survives to the main thread as a real Error instance for ANY op, superseded or not —
// sdk.worker.ts's Comlink.expose proxy converts every throw to a plain ErrorDTO before Comlink's own
// (separately lossy) error handling ever runs. `kind` is the one identity that DOES survive —
// lib/sdk/errors.ts's toErrorDTO carries a named custom Error subclass's own `.name` through as
// `dto.kind`, which is why search-engine.ts sets `.name` explicitly on the class.
function isSupersededRejection(e: unknown): boolean {
	return typeof e === "object" && e !== null && "kind" in e && (e as { kind?: unknown }).kind === "SearchSupersededError"
}

// Main-thread orchestration for the cache-backed drive search: owns the debounced-retune/grace/
// watchdog/stall timers deriveSearchStatus's caller is expected to arm (search-status.logic.ts's own
// doc comments), and folds the engine's push stream into hook state. `enabled` gates whether the
// feature is even wired up for the current listing (drive variant only) — `rootUuid` is a real,
// meaningful root (null means "resolve to the account root", not "disabled").
export function useDriveSearch(rootUuid: string | null, enabled: boolean): UseDriveSearchResult {
	const [input, setInputValue] = useState("")
	const [pushState, setPushState] = useState<SearchPushState>(INITIAL_PUSH_STATE)
	const [graceElapsed, setGraceElapsed] = useState(false)
	const [watchdogTripped, setWatchdogTripped] = useState(false)

	// Generation counter, not a single live-flag boolean (use-thumbnail.ts's own idiom) — this hook has
	// more than one place that can supersede an in-flight async call (a fresh open, a retune-triggered
	// reopen, an explicit close, a root/enabled change), so every async continuation below compares
	// against the CURRENT value instead of one captured flag. activeRef mirrors whether the user's
	// query currently WANTS search open, read fresh from the retune timer's callback, which — like
	// every timer here — is scheduled fresh per render and so can't go stale itself, but still fires
	// later, after further renders may have closed or superseded it.
	const generationRef = useRef(0)
	const activeRef = useRef(false)
	const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const retuneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	function clearTimers(): void {
		if (graceTimerRef.current !== null) {
			clearTimeout(graceTimerRef.current)
			graceTimerRef.current = null
		}

		if (watchdogTimerRef.current !== null) {
			clearTimeout(watchdogTimerRef.current)
			watchdogTimerRef.current = null
		}

		if (retuneTimerRef.current !== null) {
			clearTimeout(retuneTimerRef.current)
			retuneTimerRef.current = null
		}
	}

	// (Re-)arms on open and on every push (heartbeat/resync-start/snapshot) — a burst of activity keeps
	// pushing this out, so grace only actually elapses once GRACE_MS passes with nothing at all
	// happening, not merely GRACE_MS after the very first open.
	function armGrace(): void {
		if (graceTimerRef.current !== null) {
			clearTimeout(graceTimerRef.current)
		}

		setGraceElapsed(false)
		graceTimerRef.current = setTimeout(() => {
			setGraceElapsed(true)
		}, GRACE_MS)
	}

	// One flag, two durations (search-status.logic.ts's own deriveSearchStatus doc comment): the fatal
	// pre-first-result ceiling while nothing has landed yet, the soft post-result stall backstop once
	// it has.
	function armWatchdog(hasResults: boolean): void {
		if (watchdogTimerRef.current !== null) {
			clearTimeout(watchdogTimerRef.current)
		}

		setWatchdogTripped(false)
		watchdogTimerRef.current = setTimeout(
			() => {
				setWatchdogTripped(true)
			},
			hasResults ? STALL_CEILING_MS : WATCHDOG_MS
		)
	}

	function handlePush(generation: number, push: SearchPush): void {
		if (generation !== generationRef.current) {
			return
		}

		if (push.type === "snapshot") {
			setPushState(prev => ({ ...prev, hits: push.hits, total: push.total, live: push.live, hasSnapshot: true }))
			armGrace()
			armWatchdog(push.hits.length > 0)

			return
		}

		if (push.type === "resync") {
			setPushState(prev => ({ ...prev, resyncing: push.resyncing }))

			if (push.resyncing) {
				armGrace()
			}

			return
		}

		if (push.type === "heartbeat") {
			armGrace()
			setPushState(prev => {
				armWatchdog(prev.hits.length > 0)

				return prev
			})

			return
		}

		// rootDeleted
		setPushState(prev => ({ ...prev, rootDeleted: true }))
	}

	async function openSearch(name: string): Promise<void> {
		const generation = ++generationRef.current

		setPushState(INITIAL_PUSH_STATE)
		armGrace()
		armWatchdog(false)

		try {
			const snapshot = await sdkApi.searchOpen(
				{ rootUuid, name },
				Comlink.proxy((p: SearchPush) => {
					handlePush(generation, p)
				})
			)

			if (generation !== generationRef.current) {
				return
			}

			setPushState(prev => ({ ...prev, hits: snapshot.hits, total: snapshot.total, live: snapshot.live, hasSnapshot: true }))
			armGrace()
			armWatchdog(snapshot.hits.length > 0)
		} catch (e) {
			if (isSupersededRejection(e) || generation !== generationRef.current) {
				return
			}

			log.warn("drive-search", "searchOpen failed", e)
			setPushState(prev => ({ ...prev, live: false }))
		}
	}

	// Hand-rolled setTimeout debounce rather than @filen/utils's runDebounced: that helper's whole
	// value is a STABLE, created-once closure, but its callback needs this render's openSearch (itself
	// closed over the current rootUuid) — keeping a ref pointed at the latest one would mean writing to
	// a ref during render, which this codebase's react-hooks/refs lint rule (React Compiler's own
	// plugin) hard-rejects. A plain function scheduled fresh per call sidesteps that entirely: each
	// scheduled timeout closes over exactly the openSearch/name it was armed with, and activeRef (read
	// when it fires, not closed over) guards against acting on a since-closed session.
	function scheduleRetune(name: string): void {
		if (retuneTimerRef.current !== null) {
			clearTimeout(retuneTimerRef.current)
		}

		retuneTimerRef.current = setTimeout(() => {
			retuneTimerRef.current = null

			sdkApi
				.searchSetName(name)
				.then(ok => {
					// The user may have cleared/closed search (or navigated away) while this was in flight.
					if (activeRef.current && !ok) {
						void openSearch(name)
					}
				})
				.catch((e: unknown) => {
					log.warn("drive-search", "searchSetName failed", e)
				})
		}, SETCONFIG_DEBOUNCE_MS)
	}

	function closeSearchEngine(): void {
		generationRef.current++
		clearTimers()
		setPushState(INITIAL_PUSH_STATE)
		setGraceElapsed(false)
		setWatchdogTripped(false)

		sdkApi.searchClose().catch((e: unknown) => {
			log.warn("drive-search", "searchClose failed", e)
		})
	}

	function setInput(value: string): void {
		const wasActive = activeRef.current
		const isActive = value.trim() !== ""

		setInputValue(value)
		activeRef.current = isActive

		if (!enabled) {
			return
		}

		const transition = resolveSearchTransition(wasActive, isActive)

		if (transition === "open") {
			void openSearch(value)

			return
		}

		if (transition === "close") {
			closeSearchEngine()

			return
		}

		if (transition === "retune") {
			scheduleRetune(value)
		}
	}

	function clear(): void {
		setInputValue("")
		activeRef.current = false
		closeSearchEngine()
	}

	// Root/enabled change or unmount: close whatever's active and blank the box — mirrors
	// use-thumbnail.ts's live-flag idiom, generalized to the generation counter above (see its own
	// comment) since more than one trigger can supersede the in-flight close here.
	useEffect(() => {
		return () => {
			activeRef.current = false
			setInputValue("")
			closeSearchEngine()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: reset only on root/enabled change and unmount, never on every keystroke's re-render
	}, [rootUuid, enabled])

	const status = deriveSearchStatus({
		query: input,
		hasSnapshot: pushState.hasSnapshot,
		resultCount: pushState.hits.length,
		resyncing: pushState.resyncing,
		live: pushState.live,
		rootDeleted: pushState.rootDeleted,
		graceElapsed,
		watchdogTripped
	})

	const { items, parentPaths } = buildSearchResults(pushState.hits)

	return {
		input,
		setInput,
		// Derived straight from render state (matches activeRef's own value by construction — every
		// write to one is paired with the other — but this reads the actual rendered `input`, not an
		// imperative ref, for the value driving the rest of the render).
		active: input.trim() !== "",
		results: items,
		parentPaths,
		total: pushState.total,
		status,
		clear
	}
}
