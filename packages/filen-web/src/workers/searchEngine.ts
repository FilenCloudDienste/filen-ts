import { run } from "@filen/utils"
import type {
	Client,
	CacheSearch,
	CacheSearchConfig,
	CacheSearchSnapshot,
	CacheSearchWindow,
	CacheStatusMessage,
	Dir,
	File
} from "@filen/sdk-rs"
import { log } from "@/lib/log"

// Worker-side lifecycle for the SDK's cache-backed search. `CacheSearch`/`CacheSearchWindow` are
// wasm handles and can never cross Comlink, so the open/refilter/close dance lives entirely here;
// only the plain DTOs below reach the main thread, via the caller's own push callback (a
// Comlink.proxy from sdk.worker.ts's op — see that file's searchOpen/searchSetName/searchClose).
//
// One live handle at a time. A supersede token is armed synchronously (before any await) on every
// open, mirroring sdk.worker.ts's own single-writer client-swap discipline (adoptClient/
// releaseClient) — extended here to a resource whose teardown is async and must never block a
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

// Pre-warms the cache worker once per session; a directory-scoped identifier would suggest a
// per-search DB, which this is not (see configureCache's own doc comment — one shared DB, keyed by
// this path, backs every search this worker ever opens).
const CACHE_PATH = "filen-web-cache"

interface OpenToken {
	cancelled: boolean
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

function trimmedOrUndefined(value: string): string | undefined {
	const trimmed = value.trim()

	return trimmed.length > 0 ? trimmed : undefined
}

// activeRootUuid is a plain string (open()'s rootUuid param is caller-supplied, not the branded
// UuidStr client.root().uuid always is), so a membership check against the SDK's UuidStr[] needs a
// widening read — UuidStr is itself a string, so treating the array as readonly string[] to search
// it is sound in the safe (supertype) direction, never an unchecked narrowing.
function includesRoot(roots: readonly string[], candidate: string): boolean {
	return roots.includes(candidate)
}

function buildConfig(name: string): CacheSearchConfig {
	return { name: trimmedOrUndefined(name), itemType: "all", recursive: true, caseSensitive: false }
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
		try {
			searchWindow.free()
		} catch (e) {
			log.warn("search-engine", "window free failed", e)
		}
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
	// Never reset once flipped true: logout always location.reload()s the whole worker away, so
	// nothing in this worker's lifetime currently needs to clear it. A future in-SPA account switch
	// (no full reload) would have to reset this explicitly, or the new session silently inherits the
	// previous account's cache configuration.
	let configured = false
	let active: { search: CacheSearch; searchWindow: CacheSearchWindow } | null = null
	let currentToken: OpenToken | null = null
	let activeRootUuid: string | null = null
	let activePush: ((p: SearchPush) => void) | null = null

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

					if (progress.type === "started") {
						// Root-scoped: an unrelated root's resync must not flip our caller's UI.
						if (activeRootUuid !== null && includesRoot(progress.roots, activeRootUuid)) {
							activePush?.({ type: "resync", resyncing: true })
						}
					} else if (progress.type === "finished") {
						// Carries no roots — one worker-global resync at a time, so clearing is
						// unconditional (gated only on having an active session to tell at all).
						activePush?.({ type: "resync", resyncing: false })
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
		// always observes the flip.
		if (currentToken) {
			currentToken.cancelled = true
		}

		const token: OpenToken = { cancelled: false }

		currentToken = token
		activePush = push

		const resolvedRoot = rootUuid ?? client.root().uuid

		activeRootUuid = resolvedRoot

		if (!configured) {
			try {
				// A second configureCache call (a re-open after this worker already configured one)
				// verifiably succeeds silently — no error, no behavior change — so this guard is a
				// redundant-call optimization, not a correctness requirement.
				await client.configureCache(CACHE_PATH, statusListener)
			} catch (e) {
				// resyncProgress:finished is unconditional on activeRootUuid (unlike the other
				// statusListener branches), so BOTH routing fields must clear — and the shared rollback's
				// stale-handle close is a no-op here (configureCache only ever fails before any open has
				// succeeded in this worker, so nothing is installed).
				await rollBackFailedOpen(token)

				throw e
			}

			configured = true
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

				return
			}

			push({ type: "snapshot", ...dto })
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

		active = { search, searchWindow }

		if (previous) {
			void safeClose(previous.search, previous.searchWindow)
		}

		if (currentToken === token) {
			currentToken = null
		}

		const eager = searchWindow.initialSnapshot()

		if (eager !== undefined) {
			return toSnapshotDTO(eager)
		}

		return new Promise<SearchSnapshotDTO>(resolve => {
			firstSnapshotResolve = resolve
		})
	}

	// Engine-local refilter (setConfig — no network, no re-registration). `false` means there is no
	// live search to refilter (closed, or never opened this session) — the caller reopens instead.
	async function setName(name: string): Promise<boolean> {
		if (active === null) {
			return false
		}

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
			currentToken.cancelled = true
			currentToken = null
		}

		const current = active

		active = null
		activeRootUuid = null
		activePush = null

		if (current) {
			await safeClose(current.search, current.searchWindow)
		}
	}

	return { open, setName, close }
}

export type SearchEngine = ReturnType<typeof createSearchEngine>
