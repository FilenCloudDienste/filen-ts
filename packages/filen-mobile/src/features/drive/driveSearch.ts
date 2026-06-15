import {
	type CacheStatusListener,
	type CacheStatusMessage,
	CacheStatusMessage_Tags,
	ResyncProgressMessage_Tags,
	ErrorKind
} from "@filen/sdk-rs"
import auth from "@/lib/auth"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { SDK_CACHE_DIRECTORY, SDK_CACHE_PARENT_DIRECTORY, SDK_CACHE_DB_FILE, SDK_CACHE_VERSION } from "@/lib/storageRoots"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"

/**
 * Silent singleton owning the SDK cache lifecycle that backs the live, cache-backed
 * drive search. NO UI / toasts (UX lives in the hook + components).
 *
 * `init()` runs once at app setup: it sweeps stale cache versions, ensures the DB
 * directory exists (rusqlite `Connection::open` does NOT create the parent), and
 * calls `configureCache` (pure storage — opens no DB until the first search). The
 * status listener is wired here, once, and survives worker restarts.
 *
 * The search lifecycle (`open` / `setName` / `close` / `closeActive` /
 * `teardownOnLogout`) is added in the lifecycle phase; this file owns init + the
 * status listener + the version sweep.
 */
export class DriveSearch {
	private configured = false
	private versionSwept = false

	/**
	 * The root uuid of the currently-open search, or `null`. Set/cleared by the
	 * lifecycle methods; read by the status listener to root-scope `resyncing` and
	 * to detect deletion of the active root.
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
							// Worker-global resync — only flag "still searching" when it covers
							// the active search root (an unrelated root's resync must not flip our UI).
							if (this.activeRootUuid !== null && progress.inner.roots.includes(this.activeRootUuid)) {
								store.setResyncing(true)
							}
						} else if (progress.tag === ResyncProgressMessage_Tags.Finished) {
							// `Finished` carries no roots; there is one worker-global resync at a time,
							// so clearing the flag is correct. Delivery is lossy — the hook's stall
							// ceiling is the backstop if this is dropped.
							store.setResyncing(false)
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
	 * One-time cache configuration. Idempotent: a second call (e.g. re-login in the
	 * same process) is a no-op. Swallows `InvalidState` (a worker survived a prior
	 * session and the cache is already configured); any other failure marks the
	 * cache unavailable so the hook degrades to a "search unavailable" state instead
	 * of a silent dead search.
	 */
	public async init(): Promise<void> {
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
			if (unwrapSdkError(error)?.kind() === ErrorKind.InvalidState) {
				// A cache worker is already live (re-login in the same JS process). The
				// stored config is retained — treat as configured and move on.
				this.configured = true

				return
			}

			console.error("[driveSearch] configureCache failed", error)

			useDriveSearchStore.getState().setCacheUnavailable(true)
		}
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
