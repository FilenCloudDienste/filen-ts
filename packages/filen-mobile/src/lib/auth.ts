import {
	type JsClientInterface,
	type StringifiedClient,
	UnauthJsClient,
	type UnauthJsClientInterface,
	type JsClientConfig
} from "@filen/sdk-rs"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { useEffect, useState } from "react"

class Auth {
	private authedClient: JsClientInterface | null = null
	public readonly stringifiedClientStorageKey: string = "stringifiedClient"
	private unauthedClient: UnauthJsClientInterface | null = null
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

		return {
			authedSdkClient: this.authedClient as JsClientInterface,
			unauthedSdkClient: this.unauthedClient as UnauthJsClientInterface
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
		await secureStore.remove(this.stringifiedClientStorageKey)

		this.authedClient = null
		this.unauthedClient = null

		this.clientsReady = new Promise(resolve => {
			this.clientsReadyResolve = resolve
		})
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
	const [authedSdkClient, setAuthedSdkClient] = useState<JsClientInterface | null>(null)
	const [unauthedSdkClient, setUnauthedSdkClient] = useState<UnauthJsClientInterface | null>(null)

	useEffect(() => {
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
	}, [])

	return {
		authedSdkClient,
		unauthedSdkClient
	}
}

export default auth
