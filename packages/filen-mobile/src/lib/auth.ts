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

	// TODO: adapt numbers
	public readonly maxIoMemoryUsage: number = 32 * 1024 * 1024 // 32 MiB
	public readonly maxParallelRequests: number = 64
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

		while (!this.authedClient || !this.unauthedClient) {
			await new Promise<void>(resolve => setTimeout(resolve, 100))
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

		const stringifiedClient = await this.getStringifiedAuthedClientFromSecureStorage()

		if (!stringifiedClient) {
			throw new Error("Failed to store stringified client in secure storage")
		}

		await this.setSdkClients(stringifiedClient)

		return this.authedClient
	}

	public async logout(): Promise<void> {
		await secureStore.remove(this.stringifiedClientStorageKey)

		this.authedClient = null
		this.unauthedClient = null
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
