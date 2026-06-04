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
import { sync as chatsSync } from "@/components/chats/sync"
import { sync as notesSync } from "@/features/notes/components/sync"
import { reloadAppAsync } from "expo"

class Auth {
	private authedClient: JsClientInterface | null = null
	public readonly stringifiedClientStorageKey: string = "stringifiedClient"
	private unauthedClient: UnauthJsClientInterface | null = null
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

		await this.saveStringifiedClientToSecureStorage(stringifiedClient)

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

	public async saveStringifiedClientToSecureStorage(stringifiedClient: StringifiedClient): Promise<void> {
		await secureStore.set(this.stringifiedClientStorageKey, {
			...stringifiedClient,
			maxIoMemoryUsage: this.maxIoMemoryUsage,
			maxParallelRequests: this.maxParallelRequests
		})
	}

	public async login(...params: Parameters<UnauthJsClientInterface["login"]>): Promise<JsClientInterface> {
		this.unauthedClient = UnauthJsClient.fromConfig(this.jsClientBaseConfig)
		this.authedClient = await this.unauthedClient.login(...params)

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
		try {
			await Promise.all([unregisterBackgroundSync(), audio.stop(), fileProvider.disable()])
		} catch (e) {
			console.error(e)
		}

		try {
			transfers.cancelAll()
			cameraUpload.cancel()
			chatsSync.cancel()
			notesSync.cancel()
			offline.cancel()
		} catch (e) {
			console.error(e)
		}

		try {
			await Promise.all([secureStore.clear(), sqlite.clearAsync()])
		} catch (e) {
			console.error(e)
		}

		// Wait a bit for everyting to settle before reloading, to avoid potential race conditions
		await new Promise(resolve => setTimeout(resolve, 3000))

		reloadAppAsync().catch(console.error)
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
