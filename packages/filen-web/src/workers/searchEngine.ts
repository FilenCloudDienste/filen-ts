import { run, SearchResyncGate, trimmedOrUndefined } from "@filen/shared"
import type {
	Client,
	CacheSearch,
	CacheSearchConfig,
	CacheSearchItemType,
	CacheSearchSnapshot,
	CacheSearchWindow,
	CacheStatusMessage,
	Dir,
	File,
	ResyncProgressMessage
} from "@filen/sdk-rs"
import { log } from "@/lib/log"
import { throttle } from "@/lib/throttle"
import { WATCHDOG_MS } from "@/features/drive/lib/searchStatus.logic"

// Worker-side lifecycle for the SDK's cache-backed search. `CacheSearch`/`CacheSearchWindow` are
// wasm handles and can never cross Comlink, so the open/refilter/close dance lives entirely here;
// only the plain DTOs below reach the main thread, via the caller's own push callback (a
// Comlink.proxy from sdk.worker.ts's op — see that file's searchOpen/searchSetName/searchClose).
//
// One live handle at a time for the user's search; queries (the assistant's) share one handle of their own
// beside it. A supersede token is armed synchronously (before any await) on every open, mirroring
// sdk.worker.ts's own single-writer client-swap discipline (adoptClient/releaseClient) — extended here to a resource whose teardown is async and must never block a
// fresher open from proceeding.

export interface SearchHitDTO {
	parentPath: string
	item: Dir | File
}

export interface SearchSnapshotDTO {
	hits: SearchHitDTO[]
	total: bigint
	live: boolean
}

export type SearchPush =
	({ type: "snapshot" } & SearchSnapshotDTO) | { type: "resync"; resyncing: boolean } | { type: "heartbeat" } | { type: "rootDeleted" }

// `keepMs`: how long the queries' handle stays registered after the last one, so the next costs no resync.
export interface QueryTiming {
	settleMs: number
	stallMs: number
	capMs: number
	keepMs: number
}

// A running query: how much of the drive's listing the index has read (0..1) while a resync builds it,
// null outside one or when its size is unknown; and how many names contain the query's first word so far.
export interface SearchQueryProgress {
	indexed: number | null
	candidates: bigint
}

// `name`: the word whose hits these are. `settled: false`: the index may still have been growing (the
// budget ran out, the query was stopped, a resync went silent or did not converge).
export interface SearchQueryResult {
	snapshot: SearchSnapshotDTO
	settled: boolean
	name: string
}

// Raised when a newer open() supersedes this one before it ever produced a snapshot — expected
// under rapid re-opens (directory navigation, a fast reopen after a dropped connection), never a
// genuine failure. Named so a future caller can tell it apart from a real SDK error and skip
// surfacing it as one.
export class SearchSupersededError extends Error {
	constructor() {
		super("search superseded")

		// sdk.worker.ts's Comlink.expose proxy converts every thrown value on this worker to a plain
		// ErrorDTO (lib/sdk/errors.ts's toErrorDTO) before Comlink's own transport ever sees it — no
		// class/prototype survives that conversion, so `instanceof SearchSupersededError` always fails
		// once this crosses to the main thread (verified live). toErrorDTO carries a named Error
		// subclass's own `.name` through as `dto.kind`, which is the one identity that DOES survive —
		// setting it explicitly here (it otherwise inherits the unhelpful "Error") is what lets a
		// main-thread catch block discriminate a supersede from a genuine rejection by `dto.kind`.
		this.name = "SearchSupersededError"
	}
}

// Whole-set single window (mobile parity): the SDK window auto-refills this range as matches
// converge, so one getRange tracks the whole result set with no incremental re-subscribe.
export const CEILING = 1_000n

// A query's progress crosses to the page at most this often.
const PROGRESS_MS = 250

// A first registration of a root starts a resync after a remote validation; a query waits this long for
// its first message before calling the index unconfirmed (the messages are lossy).
const RESYNC_START_MS = 5_000

// Pre-warms the cache worker once per session; a directory-scoped identifier would suggest a
// per-search DB, which this is not (see configureCache's own doc comment — one shared DB, keyed by
// this path, backs every search this worker ever opens).
const CACHE_PATH = "filen-web-cache"

// Outlives its open(): the installed window keeps it, so a later open() or close() can silence that
// window's listener too, not just an open still in flight.
interface OpenToken {
	cancelled: boolean
	// Rejects an open() still waiting on its window's first delivery, which a silenced listener never makes.
	abandon?: () => void
}

function cancelToken(token: OpenToken): void {
	token.cancelled = true
	token.abandon?.()
}

// Reads the flag through a call boundary rather than a direct `token.cancelled` property read.
// `token` is captured by TWO closures that can run interleaved with this one — a later open() (via
// the shared `currentToken` this module holds) or close() flips the SAME object's field from
// elsewhere while this call is paused at an await. TS's flow analysis narrows a direct property read
// to its initializer literal within one function body (it has no model of that outside mutation), so
// it would otherwise misreport every post-await guard below as dead code — this indirection is the
// fix, not a suppression.
function isCancelled(token: OpenToken): boolean {
	return token.cancelled
}

// activeRootUuid is a plain string (open()'s rootUuid param is caller-supplied, not the branded
// UuidStr client.root().uuid always is), so a membership check against the SDK's UuidStr[] needs a
// widening read — UuidStr is itself a string, so treating the array as readonly string[] to search
// it is sound in the safe (supertype) direction, never an unchecked narrowing.
function includesRoot(roots: readonly string[], candidate: string): boolean {
	return roots.includes(candidate)
}

function buildConfig(name: string, itemType: CacheSearchItemType = "all"): CacheSearchConfig {
	return { name: trimmedOrUndefined(name), itemType, recursive: true, caseSensitive: false }
}

// The share of a resync's listing downloaded so far: whole roots before this one plus this one's bytes.
function listingShare(progress: Extract<ResyncProgressMessage, { type: "listing" }>): number | null {
	const total = progress.total_bytes

	if (total === undefined || total <= 0n || progress.root_count <= 0n) {
		return null
	}

	const root = Math.min(1, Number(progress.bytes_downloaded) / Number(total))

	return Math.min(1, (Number(progress.root_index) + root) / Number(progress.root_count))
}

function freeWindow(searchWindow: CacheSearchWindow): void {
	try {
		searchWindow.free()
	} catch (e) {
		log.warn("search-engine", "window free failed", e)
	}
}

function toSnapshotDTO(snapshot: CacheSearchSnapshot): SearchSnapshotDTO {
	return {
		hits: snapshot.results.map(hit => ({
			parentPath: hit.parentPath,
			item: hit.result.type === "dir" ? hit.result.dir : hit.result.file
		})),
		total: snapshot.total,
		live: snapshot.live
	}
}

// Verified order against the live SDK: the window unsubscribes first, then the search's own
// deterministic close, then its wasm-side free — clean, no errors, no hangs. Each step is its own
// try/catch (not one bundled defer block) so one failing step never skips the rest, mirroring
// mobile's own per-step-independent teardown.
async function safeClose(search: CacheSearch, searchWindow: CacheSearchWindow | null): Promise<void> {
	if (searchWindow !== null) {
		freeWindow(searchWindow)
	}

	try {
		await search.close()
	} catch (e) {
		log.warn("search-engine", "search close failed", e)
	}

	try {
		search.free()
	} catch (e) {
		log.warn("search-engine", "search free failed", e)
	}
}

export function createSearchEngine() {
	// The client whose cache is configured. Per client, not per worker: a logout that does not reload the
	// page (a login cancelled while it landed) leaves this worker running for the next sign-in, whose new
	// client needs its own configuration.
	let configuredFor: Client | null = null
	let configuring: { client: Client; done: Promise<void> } | null = null
	// The user's search: the single handle open/setName/close drive.
	let active: { search: CacheSearch; searchWindow: CacheSearchWindow; token: OpenToken } | null = null
	let currentToken: OpenToken | null = null
	let activeRootUuid: string | null = null
	let activePush: ((p: SearchPush) => void) | null = null
	// The filter the user's handle holds, re-issued as-is to re-read after a resync.
	let activeName = ""
	// The user's `resyncing`: from a root-covering start until the results are final.
	const resyncGate = new SearchResyncGate(resyncing => {
		activePush?.({ type: "resync", resyncing })
	})
	// Queries share one handle beside the user's, kept registered between them: closing it releases the
	// root's registration, and the next createSearch would validate it remotely and resync the whole
	// listing again. Each query refilters it (setConfig, engine-local) behind a window of its own.
	// `releasing`: let go once the resync it may carry for the user's search is over (see release()).
	let shared: { search: CacheSearch; rootUuid: string; releasing: boolean } | null = null
	let keepTimer: ReturnType<typeof setTimeout> | undefined
	// Queries run one at a time, as they refilter the one handle. Their tokens (by the caller's id too, so
	// it can stop one), so a logout can stop them.
	let queue: Promise<unknown> = Promise.resolve()
	const runs = new Set<OpenToken>()
	const queryTokens = new Map<number, OpenToken>()
	// Each running query's wake-up on resync news.
	const queryWakers = new Set<() => void>()
	// Worker-global, like the resync it tracks (one at a time): when its last message arrived (null once it
	// finished), how far its listing download got, how many resyncs began (a begin whose start message
	// dropped counts on its first message), when the last one finished, and whether it converged.
	let resyncSeenAt: number | null = null
	let resyncShare: number | null = null
	let resyncEpoch = 0
	let resyncEndedAt = 0
	let converged = true
	// Clients a logout shut the engine down for: nothing runs on one again. A new sign-in's client does.
	const retired = new WeakSet<Client>()
	let lastClient: Client | null = null

	// Read through a call, like isCancelled: shutdown() retires the client while a query is paused at an await.
	function isShutDown(client: Client): boolean {
		return retired.has(client)
	}

	// Installed once (see the `configured` guard in open()) and never re-created — reads
	// activeRootUuid/activePush fresh on every message, so one listener correctly serves every
	// open/close cycle for the rest of this worker's lifetime, not just the search that installed it.
	// A PLAIN function, same as every other wasm-facing callback in this worker (mirrors
	// sdk.worker.ts's uploadFile/downloadFileToWriter progress wrapping): `configureCache` gets this
	// closure, never `activePush` itself — `activePush` is the caller's Comlink proxy, and wasm's
	// serde layer rejects a raw proxy object handed to it directly. Calling a proxy from plain code
	// (the `activePush?.(...)` below) is the normal, supported use — only passing the proxy AS a wasm
	// callback argument is the gotcha.
	function statusListener(messages: CacheStatusMessage[]): void {
		for (const message of messages) {
			switch (message.type) {
				case "resyncProgress": {
					const progress = message.progress

					noteResync(progress)

					if (progress.type === "started") {
						// Root-scoped: an unrelated root's resync must not flip our caller's UI.
						if (activeRootUuid !== null && includesRoot(progress.roots, activeRootUuid)) {
							resyncGate.started()
						}
					} else if (progress.type === "finished") {
						// Carries no roots — one worker-global resync at a time. The gate holds `resyncing`
						// until the results are final; it ignores a finish it saw no covering start for.
						resyncGate.finished(rereadActive())
					} else if (activeRootUuid !== null) {
						// listing/applying — a liveness heartbeat, deliberately NOT root-matched: it
						// keeps the caller's watchdog alive through the whole resync (our root may be
						// listed later in the same pass), not just the tick that names our own root.
						activePush?.({ type: "heartbeat" })
					}

					break
				}

				case "syncRootsDeleted": {
					if (activeRootUuid !== null && includesRoot(message.roots, activeRootUuid)) {
						activePush?.({ type: "rootDeleted" })
					}

					break
				}

				case "errors": {
					// Non-fatal — the cache worker keeps running. Log only.
					log.warn("search-engine", "cache worker reported errors", message.errors)

					break
				}
			}
		}
	}

	// A same-config refilter re-reads at once instead of after the window's debounce.
	function rereadActive(): (() => Promise<bigint>) | null {
		if (active === null) {
			return null
		}

		const { search } = active
		const config = buildConfig(activeName)

		return async () => {
			await search.setConfig(config)

			return search.total()
		}
	}

	function noteResync(progress: ResyncProgressMessage): void {
		if (progress.type === "finished") {
			resyncSeenAt = null
			resyncShare = null
			resyncEndedAt = Date.now()
			converged = progress.converged

			if (shared?.releasing === true) {
				closeShared()
			}
		} else {
			if (progress.type === "started" || resyncSeenAt === null) {
				resyncEpoch++
				converged = true
			}

			resyncSeenAt = Date.now()

			if (progress.type === "started") {
				resyncShare = null
			} else if (progress.type === "listing") {
				resyncShare = listingShare(progress)
			}
		}

		for (const wake of queryWakers) {
			wake()
		}
	}

	// A resync heard from within `stallMs`.
	function resyncRunning(stallMs: number): boolean {
		return resyncSeenAt !== null && Date.now() - resyncSeenAt < stallMs
	}

	function closeShared(): void {
		clearTimeout(keepTimer)
		keepTimer = undefined

		const current = shared

		shared = null

		if (current !== null) {
			void safeClose(current.search, null)
		}
	}

	// Lets the queries' handle go. While a resync runs and the user's search is open, that search may stand
	// on this registration (it found the root covered and started no resync of its own), so the handle goes
	// once the resync finishes or the user's search closes instead.
	function release(): void {
		if (shared === null) {
			return
		}

		if (resyncSeenAt !== null && (active !== null || currentToken !== null)) {
			shared.releasing = true

			return
		}

		closeShared()
	}

	// Idle for `keepMs` after the last query: released, but not while an index build it may carry goes on.
	function armKeep(keepMs: number, stallMs: number): void {
		clearTimeout(keepTimer)
		keepTimer = setTimeout(() => {
			if (resyncRunning(stallMs)) {
				armKeep(keepMs, stallMs)

				return
			}

			release()
		}, keepMs)
	}

	// Configured once per client, shared by the user's open and a query racing it.
	async function ensureConfigured(client: Client): Promise<void> {
		if (configuring?.client !== client) {
			const current = {
				client,
				done: client.configureCache(CACHE_PATH, statusListener).finally(() => {
					if (configuring === current) {
						configuring = null
					}
				})
			}

			configuring = current
		}

		await configuring.done

		configuredFor = client
	}

	// Rolls back a genuinely-failed open(): the routing fields that call set, PLUS whatever search was
	// still installed from the last successful open. A failed reopen otherwise leaves that stale handle
	// live — a later setName would succeed against it and refilter into a push nobody routes (the
	// caller's generation has moved on), wedging search on a terminal state until a manual clear+retype.
	// Closing it instead makes the next setName return false, which the caller already answers with a
	// clean reopen. Token-guarded: a newer open that superseded this one owns the routing state and its
	// own active handle, untouched here.
	async function rollBackFailedOpen(token: OpenToken): Promise<void> {
		if (currentToken !== token) {
			return
		}

		activeRootUuid = null
		activePush = null
		resyncGate.reset()

		const stale = active
		active = null

		if (stale !== null) {
			await safeClose(stale.search, stale.searchWindow)
		}
	}

	async function open(
		client: Client,
		{ rootUuid, name }: { rootUuid: string | null; name: string },
		push: (p: SearchPush) => void
	): Promise<SearchSnapshotDTO> {
		// Supersede synchronously, before any await, so a close() or a newer open() racing this call
		// always observes the flip. The installed window is superseded too: its deliveries are dropped
		// main-side from here on, so its listener stops building them now rather than when this open
		// reaches its install.
		if (currentToken) {
			cancelToken(currentToken)
		}

		if (active) {
			cancelToken(active.token)
		}

		const token: OpenToken = { cancelled: false }

		currentToken = token
		activePush = push
		lastClient = client

		const resolvedRoot = rootUuid ?? client.root().uuid

		activeRootUuid = resolvedRoot

		if (configuredFor !== client) {
			try {
				// A second configureCache call (a re-open after this worker already configured one)
				// verifiably succeeds silently — no error, no behavior change — so this guard is a
				// redundant-call optimization, not a correctness requirement.
				await ensureConfigured(client)
			} catch (e) {
				// resyncProgress:finished is unconditional on activeRootUuid (unlike the other
				// statusListener branches), so BOTH routing fields must clear — and the shared rollback's
				// stale-handle close is a no-op here (configureCache only ever fails before any open has
				// succeeded in this worker, so nothing is installed).
				await rollBackFailedOpen(token)

				throw e
			}
		}

		if (isCancelled(token)) {
			throw new SearchSupersededError()
		}

		let search: CacheSearch

		try {
			search = await client.createSearch(resolvedRoot, buildConfig(name))
		} catch (e) {
			await rollBackFailedOpen(token)

			throw e
		}

		if (isCancelled(token)) {
			await safeClose(search, null)

			throw new SearchSupersededError()
		}

		// Resolves open() with the first result: either the window's own eager snapshot, or —
		// undefined case — whatever the listener delivers first. A cold, never-before-searched
		// directory verifiably still returns a present-but-empty eager snapshot rather than undefined,
		// so this fallback is defensive, not the common path. Once consumed it's nulled so later
		// deliveries push normally instead of re-resolving an already-settled promise.
		let firstSnapshotResolve: ((dto: SearchSnapshotDTO) => void) | null = null

		// Plain, per-open closure handed to getRange — same "never a raw proxy into wasm" rule as
		// statusListener above; it calls the caller's `push` proxy, never forwards it.
		function listener(snapshot: CacheSearchSnapshot): void {
			if (isCancelled(token)) {
				return
			}

			const dto = toSnapshotDTO(snapshot)
			const resolveFirst = firstSnapshotResolve

			if (resolveFirst !== null) {
				firstSnapshotResolve = null
				resolveFirst(dto)
			} else {
				push({ type: "snapshot", ...dto })
			}

			// After the delivery, so a settle never reaches the page ahead of the results it settles.
			resyncGate.snapshot(snapshot.total)
		}

		const rangeResult = await run<CacheSearchWindow>(() => search.getRange(0n, CEILING, listener))

		if (!rangeResult.success) {
			await safeClose(search, null)
			await rollBackFailedOpen(token)

			throw rangeResult.error
		}

		const searchWindow = rangeResult.data

		if (isCancelled(token)) {
			await safeClose(search, searchWindow)

			throw new SearchSupersededError()
		}

		// Install. Whatever was previously active is now superseded by definition (one live handle at
		// a time) — close it fire-and-forget, mirroring mobile: the old window's deliveries are
		// already unreachable (nothing references its listener anymore), so there is nothing to block
		// this reopen on.
		const previous = active

		active = { search, searchWindow, token }
		activeName = name

		if (previous) {
			void safeClose(previous.search, previous.searchWindow)
		}

		if (currentToken === token) {
			currentToken = null
		}

		// A resync the queries' handle started covers this root too, but its start message went by before
		// this search existed; the finish message clears it. The caller reset its state for this open, so
		// a resync still finalizing is re-announced too.
		if (resyncGate.converging) {
			push({ type: "resync", resyncing: true })
		} else if (resyncRunning(WATCHDOG_MS)) {
			resyncGate.started()
		}

		const eager = searchWindow.initialSnapshot()

		if (eager !== undefined) {
			resyncGate.snapshot(eager.total)

			return toSnapshotDTO(eager)
		}

		return new Promise<SearchSnapshotDTO>((resolve, reject) => {
			firstSnapshotResolve = resolve
			token.abandon = () => {
				reject(new SearchSupersededError())
			}
		})
	}

	// A one-shot search for a caller that is not the search box (the assistant), on the queries' handle: the
	// user's search is never touched, and while the user's covers the drive this one costs no network. It
	// waits until the hits have been still for `settleMs` outside a resync, at most `capMs`; a resync silent
	// for `stallMs` ends the wait without having settled (its finish message may have been dropped). When the
	// first name matches more than the window holds, the others are tried in turn, and the one with the
	// fewest hits wins.
	async function query(
		client: Client,
		params: { rootUuid: string | null; names: readonly string[]; itemType?: CacheSearchItemType },
		{ id, ...timing }: QueryTiming & { id?: number },
		onProgress?: (progress: SearchQueryProgress) => void
	): Promise<SearchQueryResult> {
		const token: OpenToken = { cancelled: false }
		const deadline = Date.now() + timing.capMs

		runs.add(token)

		if (id !== undefined) {
			queryTokens.set(id, token)
		}

		const turn = queue.then(() => runQuery(client, params, timing, deadline, token, onProgress))

		queue = turn.catch(() => undefined)

		try {
			return await turn
		} finally {
			runs.delete(token)

			if (id !== undefined) {
				queryTokens.delete(id)
			}
		}
	}

	// Stops the query its caller started under `id`: it answers at once with what it has.
	function cancelQuery(id: number): void {
		const token = queryTokens.get(id)

		if (token !== undefined) {
			cancelToken(token)
		}
	}

	async function runQuery(
		client: Client,
		{ rootUuid, names, itemType = "all" }: { rootUuid: string | null; names: readonly string[]; itemType?: CacheSearchItemType },
		timing: QueryTiming,
		deadline: number,
		token: OpenToken,
		onProgress: ((progress: SearchQueryProgress) => void) | undefined
	): Promise<SearchQueryResult> {
		const [first = ""] = names
		const nothing: SearchQueryResult = { snapshot: { hits: [], total: 0n, live: true }, settled: false, name: first }

		if (isCancelled(token) || isShutDown(client)) {
			return nothing
		}

		lastClient = client

		clearTimeout(keepTimer)

		// Set when this query registered the root itself: a resync is due, and the index is not complete
		// until one has begun and finished.
		let cold: { since: number; epoch: number } | null = null
		let handle: { search: CacheSearch; rootUuid: string; releasing: boolean } | null = null

		try {
			if (configuredFor !== client) {
				await ensureConfigured(client)
			}

			// A resync whose finish never arrived is over.
			if (resyncSeenAt !== null && !resyncRunning(timing.stallMs)) {
				resyncSeenAt = null
				resyncShare = null
			}

			const root = rootUuid ?? client.root().uuid
			let created = false

			if (shared !== null && shared.rootUuid !== root) {
				closeShared()
			}

			if (shared === null) {
				if (isCancelled(token)) {
					return nothing
				}

				// Covered only by a user's search on this very root, or maybe by one still opening.
				const uncovered = currentToken === null && (active === null || activeRootUuid !== root)
				const epoch = resyncEpoch
				const search = await client.createSearch(root, buildConfig(first, itemType))

				if (isShutDown(client)) {
					void safeClose(search, null)

					return nothing
				}

				shared = { search, rootUuid: root, releasing: false }
				created = true
				cold = uncovered ? { since: Date.now(), epoch } : null
			}

			const current = shared

			current.releasing = false
			handle = current

			let best: SearchQueryResult | null = null

			// The next word is asked for while the words so far matched nothing (a descriptive word the name lacks:
			// "tax return" for "Tax 2023.pdf") or more names than the window holds; refiltering is the engine's own
			// work, no request.
			for (const [index, name] of names.entries()) {
				if (
					index > 0 &&
					(best === null ||
						!best.settled ||
						(best.snapshot.total > 0n && best.snapshot.total <= BigInt(best.snapshot.hits.length)))
				) {
					break
				}

				if (isCancelled(token)) {
					break
				}

				if (!(index === 0 && created)) {
					const refiltered = await run(() => current.search.setConfig(buildConfig(name, itemType)))

					if (!refiltered.success) {
						if (index === 0) {
							closeShared()

							throw refiltered.error
						}

						break
					}
				}

				const seen = await look(
					current.search,
					buildConfig(name, itemType),
					timing,
					deadline,
					token,
					index === 0 ? cold : null,
					index === 0 ? onProgress : undefined
				).catch((e: unknown) => {
					// A handle that cannot open a window is no use to the next query either.
					closeShared()

					throw e
				})

				if (seen === null) {
					break
				}

				// A word with hits beats one without; among those with hits, the fewest (the most selective).
				if (
					best === null ||
					(seen.settled && seen.snapshot.total > 0n && (best.snapshot.total === 0n || seen.snapshot.total < best.snapshot.total))
				) {
					best = { snapshot: toSnapshotDTO(seen.snapshot), settled: seen.settled, name }
				}
			}

			return best ?? nothing
		} finally {
			if (handle !== null && shared === handle && !isShutDown(client)) {
				// Stopped while the index was still being built: the user's Stop ends that build too, unless the
				// user's own search may stand on it.
				const building = resyncSeenAt !== null || (cold !== null && resyncEpoch === cold.epoch)

				if (isCancelled(token) && building) {
					release()
				}

				if (shared === handle && !handle.releasing) {
					armKeep(timing.keepMs, timing.stallMs)
				}
			}
		}
	}

	// One word's hits through a window of its own, so a late delivery for the previous word can never be
	// taken for this one's. Null when the window yielded nothing usable for this word.
	async function look(
		search: CacheSearch,
		config: CacheSearchConfig,
		{ settleMs, stallMs }: QueryTiming,
		deadline: number,
		token: OpenToken,
		cold: { since: number; epoch: number } | null,
		onProgress: ((progress: SearchQueryProgress) => void) | undefined
	): Promise<{ snapshot: CacheSearchSnapshot; settled: boolean } | null> {
		const endedAt = resyncEndedAt
		let latest: CacheSearchSnapshot | null = null
		// The window's listener assigns `latest` from outside this flow.
		const seen = (): CacheSearchSnapshot | null => latest
		let changedAt = Date.now()
		let wake: (() => void) | null = null
		let open = true
		const report = throttle((progress: SearchQueryProgress) => {
			if (open) {
				onProgress?.(progress)
			}
		}, PROGRESS_MS)

		const update = () => {
			changedAt = Date.now()

			if (onProgress !== undefined && latest !== null) {
				report({ indexed: resyncSeenAt === null ? null : resyncShare, candidates: latest.total })
			}

			wake?.()
		}

		// Our own resync has not been heard of yet.
		const pending = () => cold !== null && resyncEpoch === cold.epoch

		// Resolves true once still, false at the deadline, when stopped, or when the index stays unconfirmed (a
		// resync went silent, never began, or did not converge).
		const still = () =>
			new Promise<boolean>(resolve => {
				let timer: ReturnType<typeof setTimeout> | undefined

				const finish = (settled: boolean) => {
					clearTimeout(timer)
					wake = null
					queryWakers.delete(update)
					delete token.abandon
					resolve(settled)
				}

				const check = () => {
					clearTimeout(timer)

					const now = Date.now()

					if (isCancelled(token)) {
						finish(false)

						return
					}

					// Not live is terminal: nothing changes any more.
					if (latest !== null && !latest.live) {
						finish(true)

						return
					}

					let until = latest === null ? Infinity : changedAt + settleMs

					if (resyncSeenAt !== null) {
						until = Math.max(until, resyncSeenAt + stallMs)
					} else if (cold !== null && pending()) {
						until = Math.max(until, Math.max(cold.since, resyncEndedAt) + RESYNC_START_MS)
					}

					if (until <= now) {
						finish(resyncSeenAt === null && !pending() && converged)
					} else if (now >= deadline) {
						finish(false)
					} else {
						timer = setTimeout(check, Math.min(until, deadline) - now)
					}
				}

				wake = check
				queryWakers.add(update)
				token.abandon = check
				check()
			})

		const range = await run<CacheSearchWindow>(() =>
			search.getRange(0n, CEILING, snapshot => {
				if (open) {
					latest = snapshot
					update()
				}
			})
		)

		if (!range.success) {
			throw range.error
		}

		const searchWindow = range.data

		try {
			const eager = searchWindow.initialSnapshot()

			// A delivery that beat the eager snapshot is newer.
			if (eager !== undefined && seen() === null) {
				latest = eager
				update()
			}

			let settled = await still()

			report.flush()

			// A resync commits its last batch before its finish message, and the engine re-reads the hits and its
			// total only after a debounce of up to seconds, so both may still predate that batch (an empty first
			// index taken for "no match"). A refilter re-reads them at once.
			let readAt = endedAt

			if (settled && resyncEndedAt !== readAt) {
				readAt = resyncEndedAt
				settled = (await run(() => search.setConfig(config))).success
			}

			// The handle's own total says whether a delivery for this word is still due: one more is waited
			// for, and a word whose hits still disagree with it is left unconfirmed.
			const agrees = async () => {
				const total = await run(() => search.total())

				return total.success && latest !== null && total.data === latest.total
			}

			if (settled && !(await agrees())) {
				changedAt = Date.now()
				settled = (await still()) && (await agrees())
			}

			return latest === null ? null : { snapshot: latest, settled: settled && resyncEndedAt === readAt }
		} finally {
			open = false
			freeWindow(searchWindow)
		}
	}

	// Engine-local refilter (setConfig — no network, no re-registration). `false` means there is no
	// live search to refilter (closed, or never opened this session) — the caller reopens instead.
	async function setName(name: string): Promise<boolean> {
		if (active === null) {
			return false
		}

		activeName = name

		try {
			await active.search.setConfig(buildConfig(name))

			return true
		} catch (e) {
			log.warn("search-engine", "setConfig failed, caller should reopen", e)

			return false
		}
	}

	async function close(): Promise<void> {
		if (currentToken) {
			cancelToken(currentToken)
			currentToken = null
		}

		const current = active

		if (current) {
			cancelToken(current.token)
		}

		active = null
		activeRootUuid = null
		activePush = null
		resyncGate.reset()

		if (shared?.releasing === true) {
			closeShared()
		}

		if (current) {
			await safeClose(current.search, current.searchWindow)
		}
	}

	// Logout: every query stops and every handle closes, the user's too, before the client is released.
	async function shutdown(): Promise<void> {
		if (lastClient !== null) {
			retired.add(lastClient)
		}

		lastClient = null
		configuredFor = null
		configuring = null
		// The index state was the old session's; the next client starts with its own.
		resyncSeenAt = null
		resyncShare = null
		resyncEndedAt = 0
		converged = true

		for (const token of runs) {
			cancelToken(token)
		}

		clearTimeout(keepTimer)
		keepTimer = undefined

		const current = shared

		shared = null

		await Promise.all([close(), ...(current === null ? [] : [safeClose(current.search, null)])])
	}

	return { open, query, cancelQuery, setName, close, shutdown }
}
