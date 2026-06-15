import { AppState } from "react-native"
import {
	type CacheStatusListener,
	type CacheStatusMessage,
	type CacheSearchInterface,
	type CacheSearchWindowHandle,
	type CacheSearchSnapshot,
	type CacheSearchWindowListener,
	CacheStatusMessage_Tags,
	ResyncProgressMessage_Tags,
	CacheSearchItemType,
	ErrorKind,
	FilenSdkError
} from "@filen/sdk-rs"
import auth from "@/lib/auth"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { SDK_CACHE_DIRECTORY, SDK_CACHE_PARENT_DIRECTORY, SDK_CACHE_DB_FILE, SDK_CACHE_VERSION } from "@/lib/storageRoots"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"

// One window loads the whole match set (up to this cap) so the local sort produces a
// correct GLOBAL order for the user's sort pref — the SDK window is hardcoded
// name-ascending, so re-sorting a partial window would be incoherent. The SDK window
// auto-refills its requested range as results stream in, so a single getRange tracks
// the converging set; no incremental grow. Beyond the cap the list truncates (the
// alphabetically-first `CEILING`) with a "refine search" hint.
const CEILING = 5000

// Dedupe key for the account-root search (rootUuid === null).
const ROOT_KEY = "__account_root__"

type OpenArgs = {
	rootUuid: string | null
	name: string
	onSnapshot: (snapshot: CacheSearchSnapshot) => void
	signal: AbortSignal
}

// A per-open cancellation token, flipped by a newer open or by closeActive. Set
// SYNCHRONOUSLY at the very start of an open (before any await), so a close that
// arrives while the open is mid-network is always observed by the open's guards.
type OpenToken = { cancelled: boolean }

/**
 * Silent singleton owning the SDK cache lifecycle that backs the live, cache-backed
 * drive search. NO UI / toasts (UX lives in the hook + components).
 *
 * Exactly one search is live at a time (single source for the drive list). An open is
 * guarded by a cancellation token captured before any await; a newer open or a
 * closeActive() flips it, so an open that resolves after being superseded closes its
 * orphan instead of installing it (JS is single-threaded, so the token check + the
 * `active` assignment are atomic — no lock needed).
 */
export class DriveSearch {
	private configured = false
	private versionSwept = false
	private appStateSubscribed = false

	private active: { search: CacheSearchInterface; windowHandle: CacheSearchWindowHandle } | null = null
	private currentOpenToken: OpenToken | null = null
	private inflightOpen: Promise<void> | null = null
	private inflightRoot: string | null = null

	/**
	 * Root uuid of the currently-open (or opening) search, or `null`. Read by the
	 * status listener to root-scope `resyncing` and to detect deletion of the active root.
	 */
	protected activeRootUuid: string | null = null

	private readonly statusListener: CacheStatusListener = {
		onMessages: (messages: CacheStatusMessage[]) => {
			const store = useDriveSearchStore.getState()

			for (const message of messages) {
				switch (message.tag) {
					case CacheStatusMessage_Tags.ResyncProgress: {
						const progress = message.inner.progress

						if (progress.tag === ResyncProgressMessage_Tags.Started) {
							// Worker-global resync — only flag "still searching" when it covers the
							// active search root (an unrelated root's resync must not flip our UI).
							if (this.activeRootUuid !== null && progress.inner.roots.includes(this.activeRootUuid)) {
								store.setResyncing(true)
							}
						} else if (progress.tag === ResyncProgressMessage_Tags.Finished) {
							// `Finished` carries no roots; one worker-global resync at a time, so clearing
							// is correct. Delivery is best-effort — the hook's stall ceiling is the backstop.
							store.setResyncing(false)
						} else if (this.activeRootUuid !== null) {
							// Listing (~every 200ms during the network phase) / Applying — a LIVENESS
							// heartbeat. One worker-global resync at a time, so any progress while we have
							// an active search is ours (Listing may be on a sibling root we converge after).
							// The hook re-arms its watchdog + stall timers on this so a slow-but-progressing
							// search never false-fails. Not root-matched: keeping us alive through the whole
							// global resync is correct (our results converge when our root is listed).
							store.bumpResyncProgress()
						}

						break
					}

					case CacheStatusMessage_Tags.SyncRootsDeleted: {
						if (this.activeRootUuid !== null && message.inner.roots.includes(this.activeRootUuid)) {
							store.setRootDeleted(true)
						}

						break
					}

					case CacheStatusMessage_Tags.Errors: {
						// Non-fatal — the worker keeps running. Log only (silent infra).
						console.error("[driveSearch] cache worker errors", message.inner.errors)

						break
					}
				}
			}
		}
	}

	/**
	 * One-time cache configuration. Idempotent. Swallows `InvalidState` (a worker
	 * survived a prior session). Any other failure marks the cache unavailable so the
	 * hook degrades to "search unavailable" instead of a silent dead search. Also
	 * subscribes (once) to AppState so the search is closed on backgrounding — this
	 * releases the worker's socket listener so the shared WebSocket can close (the OS
	 * suspends backgrounded apps; holding the socket open risks termination).
	 */
	public async init(): Promise<void> {
		this.subscribeAppState()

		if (this.configured) {
			return
		}

		this.sweepOldVersions()

		if (!SDK_CACHE_DIRECTORY.exists) {
			SDK_CACHE_DIRECTORY.create({ idempotent: true, intermediates: true })
		}

		try {
			const { authedSdkClient } = await auth.getSdkClients()

			await authedSdkClient.configureCache(normalizeFilePathForSdk(SDK_CACHE_DB_FILE.uri), this.statusListener)

			this.configured = true
		} catch (error) {
			const inner = FilenSdkError.hasInner(error) ? FilenSdkError.getInner(error) : null

			if (inner?.kind() === ErrorKind.InvalidState) {
				// A cache worker is already live (re-login in the same JS process). The stored
				// config is retained — treat as configured and move on.
				this.configured = true

				return
			}

			console.error("[driveSearch] configureCache failed", error)

			useDriveSearchStore.getState().setCacheUnavailable(true)
		}
	}

	/**
	 * Open (or re-target) the single live search over `rootUuid`'s subtree (account
	 * root when `null`). Concurrent calls for the same root return the in-flight
	 * promise (absorbs StrictMode double-mount). The caller's `onSnapshot` receives the
	 * initial window plus every live update; `signal` (a raw AbortSignal) cancels an
	 * in-flight create on close/clear. Rejects if `createSearch` fails (the hook treats
	 * a rejected open as terminal).
	 */
	public open(args: OpenArgs): Promise<void> {
		const key = args.rootUuid ?? ROOT_KEY

		if (this.inflightOpen !== null && this.inflightRoot === key) {
			return this.inflightOpen
		}

		this.inflightRoot = key

		const promise = this.doOpen(args).finally(() => {
			if (this.inflightOpen === promise) {
				this.inflightOpen = null
				this.inflightRoot = null
			}
		})

		this.inflightOpen = promise

		return promise
	}

	private async doOpen({ rootUuid, name, onSnapshot, signal }: OpenArgs): Promise<void> {
		// Supersede any prior in-flight open and arm our token — synchronously, before any
		// await, so a closeActive() racing this open always sees and flips the token.
		if (this.currentOpenToken) {
			this.currentOpenToken.cancelled = true
		}

		const token: OpenToken = { cancelled: false }

		this.currentOpenToken = token

		// configureCache MUST have run before createSearch (the SDK throws otherwise). init()
		// is fired (un-awaited) at app setup, so in practice it's done by the time a user
		// searches — but on a cold start a fast search could outrun it. Idempotent: a no-op
		// once configured. Closing during this await flips the token, caught just below.
		if (!this.configured) {
			await this.init()
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const resolvedRoot = rootUuid ?? authedSdkClient.root().uuid

		if (token.cancelled) {
			return
		}

		this.activeRootUuid = resolvedRoot

		const listener: CacheSearchWindowListener = {
			onSnapshot: snapshot => {
				if (!token.cancelled) {
					onSnapshot(snapshot)
				}
			}
		}

		let search: CacheSearchInterface

		try {
			search = await authedSdkClient.createSearch(
				resolvedRoot,
				{ name: name.trim() || undefined, itemType: CacheSearchItemType.All, recursive: true, caseSensitive: false },
				{ signal }
			)
		} catch (error) {
			// Aborted (close/clear) or rejected — no Search handle to clean up. Clear the active
			// root (if still ours) so the status listener doesn't flag a search that never opened.
			if (this.currentOpenToken === token) {
				this.activeRootUuid = null
			}

			throw error
		}

		// Superseded during createSearch → close the orphan, skip getRange.
		if (token.cancelled) {
			await this.safeClose(search, null)

			return
		}

		const window = await search.getRange(0n, BigInt(CEILING), listener, { signal })
		const windowHandle = window.handle as CacheSearchWindowHandle

		// Superseded during getRange → close + destroy, don't install.
		if (token.cancelled) {
			await this.safeClose(search, windowHandle)

			return
		}

		// Install (the check above and this assignment are synchronous — atomic in JS).
		this.active = { search, windowHandle }

		if (this.currentOpenToken === token) {
			this.currentOpenToken = null
		}

		onSnapshot(window.snapshot)
	}

	/** Re-filter the live search in place (engine-local; no network, no recreate). */
	public async setName(name: string): Promise<void> {
		const search = this.active?.search

		if (!search) {
			return
		}

		try {
			await search.setConfig({
				name: name.trim() || undefined,
				itemType: CacheSearchItemType.All,
				recursive: true,
				caseSensitive: false
			})
		} catch (error) {
			console.error("[driveSearch] setConfig failed", error)
		}
	}

	/**
	 * Close the live search and reset status. Cancels any in-flight open (so it
	 * orphan-closes instead of installing) and clears the in-flight latch (so a
	 * post-close reopen starts fresh, never deduping onto a doomed promise). Idempotent.
	 */
	public async closeActive(): Promise<void> {
		if (this.currentOpenToken) {
			this.currentOpenToken.cancelled = true
			this.currentOpenToken = null
		}

		const current = this.active

		this.active = null
		this.activeRootUuid = null
		this.inflightOpen = null
		this.inflightRoot = null

		if (current) {
			await this.safeClose(current.search, current.windowHandle)
		}

		const store = useDriveSearchStore.getState()

		store.setResyncing(false)
		store.setRootDeleted(false)
	}

	/**
	 * Logout teardown: close the live search (releasing the worker's socket listener
	 * while the client is still alive), then delete the cache DB (decrypted names at
	 * rest). MUST run before the authed client is destroyed.
	 */
	public async teardownOnLogout(): Promise<void> {
		await this.closeActive()

		this.configured = false
		this.versionSwept = false

		try {
			if (SDK_CACHE_DIRECTORY.exists) {
				SDK_CACHE_DIRECTORY.delete()
			}
		} catch (error) {
			console.error("[driveSearch] failed to delete cache directory on logout", error)
		}
	}

	private async safeClose(search: CacheSearchInterface, windowHandle: CacheSearchWindowHandle | null): Promise<void> {
		try {
			await search.close()
		} catch (error) {
			console.error("[driveSearch] error closing search", error)
		}

		if (windowHandle) {
			try {
				windowHandle.uniffiDestroy()
			} catch (error) {
				console.error("[driveSearch] error destroying window handle", error)
			}
		}
	}

	private subscribeAppState(): void {
		if (this.appStateSubscribed) {
			return
		}

		this.appStateSubscribed = true

		AppState.addEventListener("change", state => {
			if (state === "background") {
				void this.closeActive()
			}
		})
	}

	// Delete any non-current `sdkCache/v*` sibling so a version bump invalidates old
	// (decrypted-name) data. Runs once per process. Mirrors offline.ts's sweep.
	private sweepOldVersions(): void {
		if (this.versionSwept || !SDK_CACHE_PARENT_DIRECTORY.exists) {
			return
		}

		this.versionSwept = true

		for (const entry of SDK_CACHE_PARENT_DIRECTORY.list()) {
			if (entry.name !== `v${SDK_CACHE_VERSION}`) {
				try {
					entry.delete()
				} catch (error) {
					console.error("[driveSearch] failed to sweep stale cache version", error)
				}
			}
		}
	}
}

const driveSearch = new DriveSearch()

export default driveSearch
