import {
	type JsClient,
	type JsClientInterface,
	type StringifiedClient,
	UnauthJsClient,
	type UnauthJsClientInterface,
	type JsClientConfig
} from "@filen/sdk-rs"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { useEffect, useState } from "react"
import transfers from "@/lib/transfers"
import cameraUpload from "@/lib/cameraUpload"
import { unregisterBackgroundSync } from "@/lib/backgroundTask"
import fileProvider from "@/lib/fileProvider"
import cache from "@/lib/cache"
import sqlite from "@/lib/sqlite"
import offline from "@/lib/offline"
import thumbnails from "@/lib/thumbnails"
import { sweepTmpDir } from "@/lib/tmp"
import { queryClient, queryClientPersisterKv } from "@/queries/client"

class Auth {
	private authedClient: JsClientInterface | null = null
	public readonly stringifiedClientStorageKey: string = "stringifiedClient"
	private unauthedClient: UnauthJsClientInterface | null = null
	private logoutPromise: Promise<void> | null = null
	private clientsReadyResolve: (() => void) | null = null
	private clientsReady: Promise<void> = new Promise(resolve => {
		this.clientsReadyResolve = resolve
	})
	public readonly maxIoMemoryUsage: number = 64 * 1024 * 1024 // 64 MiB
	public readonly maxParallelRequests: number = 128
	public readonly jsClientBaseConfig: JsClientConfig = {
		concurrency: undefined,
		rateLimitPerSec: undefined,
		uploadBandwidthKilobytesPerSec: undefined,
		downloadBandwidthKilobytesPerSec: undefined,
		logLevel: undefined,
		fileIoMemoryBudget: undefined
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

	public async setSdkClients(stringifiedClient: StringifiedClient): Promise<{
		authedClient: JsClientInterface
		unauthedClient: UnauthJsClientInterface
	}> {
		this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)

		this.authedClient = this.unauthedClient.fromStringified({
			...stringifiedClient,
			maxIoMemoryUsage: this.maxIoMemoryUsage,
			maxParallelRequests: this.maxParallelRequests
		})

		this.notifyClientsReady()

		return {
			authedClient: this.authedClient,
			unauthedClient: this.unauthedClient
		}
	}

	public async getStringifiedAuthedClientFromSecureStorage(): Promise<StringifiedClient | null> {
		return await secureStore.get<StringifiedClient>(this.stringifiedClientStorageKey)
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

	public async login(...params: Parameters<UnauthJsClientInterface["login"]>): Promise<JsClientInterface> {
		this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		this.authedClient = await this.unauthedClient.login(...params)

		if (!this.authedClient) {
			throw new Error("Login failed, authed client is null")
		}

		await secureStore.set(this.stringifiedClientStorageKey, {
			...(await this.authedClient.toStringified()),
			maxIoMemoryUsage: this.maxIoMemoryUsage,
			maxParallelRequests: this.maxParallelRequests
		})

		this.notifyClientsReady()

		return this.authedClient
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
		// 1. Cancel in-flight work that uses the SDK so post-destroy callbacks
		//    don't hit a freed Arc<JsClient>.
		transfers.cancelAll()
		cameraUpload.cancel()

		// 2. Stop scheduled native work.
		try {
			await unregisterBackgroundSync()
		} catch (e) {
			console.error("[Auth] unregisterBackgroundSync failed:", e)
		}

		try {
			await fileProvider.disable()
		} catch (e) {
			console.error("[Auth] fileProvider.disable failed:", e)
		}

		// 3. Stash + null SDK client refs. Destroy after the React unmount cascade
		//    (steps 4-5) so still-mounted components holding the old client don't
		//    call methods on a freed Arc.
		const oldAuthedClient = this.authedClient
		const oldUnauthedClient = this.unauthedClient

		this.authedClient = null
		this.unauthedClient = null
		this.clientsReady = new Promise(resolve => {
			this.clientsReadyResolve = resolve
		})

		// 4. Remove the auth secret → useIsAuthed flips to false → useSdkClients
		//    sets its state to (null, null) via the isAuthed dependency → the root
		//    layout unmounts <Socket />/<Http /> → their cleanup destroys their
		//    listener / provider handles.
		await secureStore.remove(this.stringifiedClientStorageKey)

		// 5. Yield one macrotask so React flushes the unmount before we destroy
		//    the parent Arc<JsClient> that unmounted components were holding.
		await new Promise<void>(resolve => setTimeout(resolve, 0))

		// 6. Free the Rust Arc<JsClient> / Arc<UnauthJsClient>. uniffiDestroy lives
		//    on the concrete class (inherited from UniffiAbstractObject), not on the
		//    interface — the actual runtime objects are instances of JsClient /
		//    UnauthJsClient so the cast is safe.
		try {
			;(oldAuthedClient as JsClient | null)?.uniffiDestroy()
		} catch (e) {
			console.error("[Auth] authedClient.uniffiDestroy failed:", e)
		}

		try {
			;(oldUnauthedClient as UnauthJsClient | null)?.uniffiDestroy()
		} catch (e) {
			console.error("[Auth] unauthedClient.uniffiDestroy failed:", e)
		}

		// 7. Wipe every surface that holds decrypted user data. Per-step try/catch
		//    so one failure doesn't block the rest — partial wipe beats no wipe.
		cache.rootUuid = null

		try {
			cache.clear()
		} catch (e) {
			console.error("[Auth] cache.clear failed:", e)
		}

		try {
			queryClient.clear()
		} catch (e) {
			console.error("[Auth] queryClient.clear failed:", e)
		}

		try {
			queryClientPersisterKv.clear()
		} catch (e) {
			console.error("[Auth] queryClientPersisterKv.clear failed:", e)
		}

		// Single awaited DELETE FROM kv wipes cache:v1:*, reactQuery_v1:*,
		// inflightChatMessages and inflightNoteContent in one go — replaces the
		// fire-and-forget removes that cache.clear() / queryClientPersisterKv.clear()
		// schedule, so we know the disk is clean before the next login.
		try {
			await sqlite.kvAsync.clear()
		} catch (e) {
			console.error("[Auth] sqlite.kvAsync.clear failed:", e)
		}

		try {
			await offline.clearAll()
		} catch (e) {
			console.error("[Auth] offline.clearAll failed:", e)
		}

		try {
			await thumbnails.clear()
		} catch (e) {
			console.error("[Auth] thumbnails.clear failed:", e)
		}

		try {
			sweepTmpDir()
		} catch (e) {
			console.error("[Auth] sweepTmpDir failed:", e)
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
