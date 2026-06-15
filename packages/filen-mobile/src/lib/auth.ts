import {
	type JsClientInterface,
	type StringifiedClient,
	UnauthJsClient,
	type UnauthJsClientInterface,
	type JsClientConfig,
	LogLevel
} from "@filen/sdk-rs"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { useEffect, useState } from "react"
import transfers from "@/features/transfers/transfers"
import cameraUpload from "@/features/cameraUpload/cameraUpload"
import { unregisterBackgroundSync } from "@/features/cameraUpload/backgroundTask"
import fileProvider from "@/features/settings/fileProvider"
import sqlite from "@/lib/sqlite"
import audio from "@/features/audio/audio"
import offline from "@/features/offline/offline"
import offlineSync from "@/features/offline/offlineSync"
import { sync as chatsSync } from "@/features/chats/components/sync"
import { sync as notesSync } from "@/features/notes/components/sync"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"
import thumbnails from "@/lib/thumbnails"
import sandboxCache from "@/lib/sandboxCache"
import driveSearch from "@/features/drive/driveSearch"
import { reloadAppAsync } from "expo"
import { isEqual } from "es-toolkit"

const RELOAD_RETRY_DELAY = 1000
const RELOAD_MAX_ATTEMPTS = 5

class Auth {
	private authedClient: JsClientInterface | null = null
	public readonly stringifiedClientStorageKey: string = "stringifiedClient"
	private unauthedClient: UnauthJsClientInterface | null = null
	// The stringified config the CURRENT clients were built from — setSdkClients' same-input
	// fast path. null whenever the clients were replaced outside setSdkClients (login) or torn
	// down (logout), so the next setSdkClients always reconstructs.
	private lastStringifiedClient: StringifiedClient | null = null
	private logoutPromise: Promise<void> | null = null
	private clientsReadyResolve: (() => void) | null = null
	private clientsReady: Promise<void> = new Promise(resolve => {
		this.clientsReadyResolve = resolve
	})
	public readonly maxIoMemoryUsage: number = 64 * 1024 * 1024
	public readonly maxParallelRequests: number = 128
	public readonly jsClientBaseConfig: JsClientConfig = {
		concurrency: 128,
		rateLimitPerSec: 128,
		uploadBandwidthKilobytesPerSec: undefined,
		downloadBandwidthKilobytesPerSec: undefined,
		logLevel: LogLevel.Info,
		fileIoMemoryBudget: BigInt(32 * 1024 * 1024)
	}

	public async isAuthed(): Promise<
		| {
				isAuthed: false
		  }
		| {
				isAuthed: true
				stringifiedClient: StringifiedClient
		  }
	> {
		const stringifiedClient = await secureStore.get<StringifiedClient>(this.stringifiedClientStorageKey)

		return stringifiedClient !== null
			? {
					isAuthed: true,
					stringifiedClient
				}
			: {
					isAuthed: false
				}
	}

	private notifyClientsReady(): void {
		if (!this.clientsReadyResolve) {
			return
		}

		this.clientsReadyResolve()

		this.clientsReadyResolve = null
	}

	/**
	 * Re-arm clientsReady with a fresh unresolved promise + resolver. Called on logout so any
	 * post-wipe getSdkClients() awaiter blocks on the next setSdkClients()/login() instead of
	 * being handed a client whose persisted credentials were just erased.
	 */
	private armClientsReady(): void {
		this.clientsReady = new Promise(resolve => {
			this.clientsReadyResolve = resolve
		})
	}

	/**
	 * Best-effort uniffiDestroy of an SDK client handle. The exported interfaces don't declare
	 * uniffiDestroy (only the concrete JsClient/UnauthJsClient classes do, via UniffiAbstractObject),
	 * so cast to the structural shape and swallow failures — a destroy error must not abort teardown.
	 */
	private destroyClient(client: JsClientInterface | UnauthJsClientInterface | null): void {
		if (!client) {
			return
		}

		try {
			;(client as unknown as { uniffiDestroy: () => void }).uniffiDestroy()
		} catch (e) {
			console.error(e)
		}
	}

	/**
	 * Quiesce the SDK clients right before an intentional JS reload (login flow's
	 * reloadAppAsync). uniffi handles have no GC — the reload kills the JS proxies but
	 * leaks the Rust Arcs (reqwest pool, rate limiter, tokio resources) unless they are
	 * destroyed first; the post-reload boot constructs fresh clients from the persisted
	 * config. clientsReady is re-armed so any straggler getSdkClients() in the doomed
	 * pre-reload window parks quietly instead of throwing. Mirrors doLogout's teardown.
	 */
	public prepareForReload(): void {
		// Login-flow reload — no drive search is open yet, so this is a no-op in practice; fired
		// (not awaited) for robustness so a live search's worker is released before the reload.
		void driveSearch.closeActive()

		this.destroyClient(this.authedClient)
		this.destroyClient(this.unauthedClient)

		this.authedClient = null
		this.unauthedClient = null
		this.lastStringifiedClient = null

		this.armClientsReady()
	}

	public async setSdkClients(stringifiedClient: StringifiedClient): Promise<{
		authedClient: JsClientInterface
		unauthedClient: UnauthJsClientInterface
	}> {
		// Same-input fast path (audit B2b, 2026-06-11): a second setup() in the same process
		// (an iOS cold background launch runs the task body's setup AND RootLayout's; a warm
		// Android process re-runs setup per WorkManager fire) re-reads the SAME stored blob.
		// Reconstructing would uniffiDestroy handles that in-flight work captured via
		// getSdkClients() mid-call. Reconstruction is only needed when the credentials
		// actually changed (login / changePassword persist a new blob).
		if (this.authedClient && this.unauthedClient && this.lastStringifiedClient !== null && isEqual(this.lastStringifiedClient, stringifiedClient)) {
			return {
				authedClient: this.authedClient,
				unauthedClient: this.unauthedClient
			}
		}

		// Destroy any handles we are about to orphan so the native Arcs (reqwest pool,
		// rate limiter, tokio resources, socket) are reclaimed deterministically instead
		// of leaning on GC finalization. Mirrors the guarded pattern register() uses.
		this.destroyClient(this.authedClient)
		this.destroyClient(this.unauthedClient)

		this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		this.authedClient = this.unauthedClient.fromStringified({
			...stringifiedClient,
			maxIoMemoryUsage: this.maxIoMemoryUsage,
			maxParallelRequests: this.maxParallelRequests
		})
		this.lastStringifiedClient = stringifiedClient

		// On launch this runs with the value just read from secureStore, and the only fields this write
		// would change are the two overrides below — which nothing reads back from disk (the SDK re-injects
		// the in-memory constants above). Skip the redundant AES-GCM encrypt + atomic file rewrite unless a
		// migration is actually needed: the stored overrides are absent (old install) or differ from the
		// current constants. login()/changePassword persist new credentials via their own paths.
		if (
			stringifiedClient.maxIoMemoryUsage !== this.maxIoMemoryUsage ||
			stringifiedClient.maxParallelRequests !== this.maxParallelRequests
		) {
			await this.saveStringifiedClientToSecureStorage(stringifiedClient)
		}

		this.notifyClientsReady()

		return {
			authedClient: this.authedClient,
			unauthedClient: this.unauthedClient
		}
	}

	public async getSdkClients(): Promise<{
		authedSdkClient: JsClientInterface
		unauthedSdkClient: UnauthJsClientInterface
	}> {
		if (this.authedClient && this.unauthedClient) {
			return {
				authedSdkClient: this.authedClient,
				unauthedSdkClient: this.unauthedClient
			}
		}

		await this.clientsReady

		if (!this.authedClient || !this.unauthedClient) {
			throw new Error("SDK clients not initialized after clientsReady resolved")
		}

		return {
			authedSdkClient: this.authedClient,
			unauthedSdkClient: this.unauthedClient
		}
	}

	public async saveStringifiedClientToSecureStorage(stringifiedClient: StringifiedClient): Promise<void> {
		await secureStore.set(this.stringifiedClientStorageKey, {
			...stringifiedClient,
			maxIoMemoryUsage: this.maxIoMemoryUsage,
			maxParallelRequests: this.maxParallelRequests
		})
	}

	public async login(...params: Parameters<UnauthJsClientInterface["login"]>): Promise<JsClientInterface> {
		// Destroy the handles we are about to replace (the login screen calls login() repeatedly —
		// wrong-password retries, the second attempt after the 2FA prompt) so each fromConfig() Arc
		// is reclaimed instead of orphaned. Mirrors the guarded pattern register() uses.
		this.destroyClient(this.authedClient)
		this.destroyClient(this.unauthedClient)

		this.authedClient = null
		this.lastStringifiedClient = null

		const unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)

		this.unauthedClient = unauthedClient

		try {
			this.authedClient = await unauthedClient.login(...params)
		} catch (e) {
			this.destroyClient(unauthedClient)

			this.unauthedClient = null

			throw e
		}

		if (!this.authedClient) {
			throw new Error("Login failed, authed client is null")
		}

		await this.saveStringifiedClientToSecureStorage(await this.authedClient.toStringified())

		this.notifyClientsReady()

		return this.authedClient
	}

	public async register(params: Parameters<UnauthJsClientInterface["register"]>[0]): Promise<void> {
		if (!this.unauthedClient) {
			this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		}

		await this.unauthedClient.register(params)
	}

	public async startPasswordReset(email: string): Promise<void> {
		if (!this.unauthedClient) {
			this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		}

		await this.unauthedClient.startPasswordReset(email)
	}

	public async resendConfirmationEmail(email: string): Promise<void> {
		if (!this.unauthedClient) {
			this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		}

		await this.unauthedClient.resendRegistrationConfirmation(email)
	}

	public async logout(): Promise<void> {
		if (this.logoutPromise) {
			await this.logoutPromise

			return
		}

		this.logoutPromise = this.doLogout().finally(() => {
			this.logoutPromise = null
		})

		await this.logoutPromise
	}

	private async doLogout(): Promise<void> {
		// Phase 1 — stop background producers. allSettled so one failure never aborts the wipe.
		const phase1 = await Promise.allSettled([unregisterBackgroundSync(), audio.stop(), fileProvider.disable()])

		for (const result of phase1) {
			if (result.status === "rejected") {
				console.error(result.reason)
			}
		}

		// Phase 2 — cancel in-flight work (synchronous aborts). These trip the abort signals the SDK
		// calls below were issued with, so awaiting them next observes settled cancellations.
		try {
			transfers.cancelAll()
			cameraUpload.cancel()
			chatsSync.cancel()
			notesSync.cancel()
			offlineSync.cancel()
		} catch (e) {
			console.error(e)
		}

		// Phase 3 — snapshot the SDK clients, then immediately null the fields and re-arm clientsReady
		// BEFORE any further await. A post-wipe getSdkClients() must block on the next session's
		// re-init rather than be handed a client whose persisted credentials are about to be erased.
		const authedClient = this.authedClient
		const unauthedClient = this.unauthedClient

		this.authedClient = null
		this.unauthedClient = null
		this.lastStringifiedClient = null

		this.armClientsReady()

		// Phase 3.5 — close the cache search BEFORE destroying the client. close() releases the
		// worker's socket listener + read connection (client-bound) and then we delete the cache DB
		// (decrypted names at rest). Must precede Phase 4 — destroyClient tears down the socket the
		// worker shares. allSettled-style isolation: never let a teardown failure abort the wipe.
		try {
			await driveSearch.teardownOnLogout()
		} catch (e) {
			console.error(e)
		}

		// Phase 4 — destroy the native handles AFTER cancellations settled (avoid use-after-destroy).
		// Destroying the authed client tears down the socket it owns, so no socket event can mutate the
		// in-memory cache during the wipe that follows.
		this.destroyClient(authedClient)
		this.destroyClient(unauthedClient)

		// Phase 5 — wipe the in-memory cache BEFORE the SQLite wipe. cache.clear() cancels the pending
		// persist debounce, bumps the clear generation, locks persistence, empties the maps + dirty
		// sets, and removes the kv rows — so a stray flush can no longer re-INSERT decrypted metadata.
		try {
			cache.clear()
		} catch (e) {
			console.error(e)
		}

		// Phase 6 — wipe persisted + decrypted-at-rest state. secureStore (auth secret), SQLite (query
		// cache + cache kv), and every decrypted-on-disk store. allSettled so a single failure can't
		// leave the rest of the wipe undone.
		const wipe = await Promise.allSettled([
			secureStore.clear(),
			sqlite.clearAsync(),
			offline.clearAll(),
			fileCache.clear(),
			thumbnails.clear(),
			sandboxCache.clear()
		])

		for (const result of wipe) {
			if (result.status === "rejected") {
				console.error(result.reason)
			}
		}

		// Phase 7 — reload the JS bundle. The in-memory + native state is now safe, so a failed reload
		// no longer leaves a live authed client behind; retry rather than swallow the rejection.
		await this.reloadWithRetry()
	}

	private async reloadWithRetry(): Promise<void> {
		for (let attempt = 1; attempt <= RELOAD_MAX_ATTEMPTS; attempt++) {
			try {
				await reloadAppAsync()

				return
			} catch (e) {
				console.error(e)

				if (attempt < RELOAD_MAX_ATTEMPTS) {
					await new Promise(resolve => setTimeout(resolve, RELOAD_RETRY_DELAY))
				}
			}
		}
	}
}

const auth = new Auth()

export function useIsAuthed(): boolean {
	const [stringifiedClient] = useSecureStore<StringifiedClient | null>(auth.stringifiedClientStorageKey, null)

	return stringifiedClient !== null
}

export function useStringifiedClient(): StringifiedClient | null {
	const [stringifiedClient] = useSecureStore<StringifiedClient | null>(auth.stringifiedClientStorageKey, null)

	return stringifiedClient
}

export function useSdkClients(): {
	authedSdkClient: JsClientInterface | null
	unauthedSdkClient: UnauthJsClientInterface | null
} {
	const isAuthed = useIsAuthed()
	const [authedSdkClient, setAuthedSdkClient] = useState<JsClientInterface | null>(null)
	const [unauthedSdkClient, setUnauthedSdkClient] = useState<UnauthJsClientInterface | null>(null)
	const [prevIsAuthed, setPrevIsAuthed] = useState(isAuthed)

	// When auth state transitions, reset the stale client refs during render
	// (React 19 recommended pattern — see useState "store info from prev render").
	// This closes the stale-snapshot bug where post-logout the hook would keep
	// returning a destroyed JsClient until the parent unmounted.
	if (prevIsAuthed !== isAuthed) {
		setPrevIsAuthed(isAuthed)
		setAuthedSdkClient(null)
		setUnauthedSdkClient(null)
	}

	useEffect(() => {
		if (!isAuthed) {
			return
		}

		let isMounted = true

		async function fetchSdkClients() {
			const { authedSdkClient, unauthedSdkClient } = await auth.getSdkClients()

			if (isMounted) {
				setAuthedSdkClient(authedSdkClient)
				setUnauthedSdkClient(unauthedSdkClient)
			}
		}

		fetchSdkClients()

		return () => {
			isMounted = false
		}
	}, [isAuthed])

	return {
		authedSdkClient,
		unauthedSdkClient
	}
}

export default auth
