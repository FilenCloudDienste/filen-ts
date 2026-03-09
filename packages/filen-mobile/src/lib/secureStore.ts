import * as ExpoSecureStore from "expo-secure-store"
import { createMMKV, type MMKV } from "react-native-mmkv"
import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import crypto from "crypto"
import { pack, unpack } from "@/lib/msgpack"
import { run, Semaphore, runEffect } from "@filen/utils"
import { useEffect, useState, useRef } from "react"
import cache from "@/lib/cache"
import events from "@/lib/events"
import { Buffer } from "@craftzdog/react-native-buffer"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import isEqual from "react-fast-compare"
import { useCallback } from "@/lib/memo"
import { normalizeFilePathForSdk } from "@/lib/utils"

class SecureStore {
	private readonly mmkv: MMKV

	private available: boolean | null = null
	private encryptionKey: string | null = null
	private readCache: Record<string, unknown> | null = null
	private initDone: boolean = false

	private readonly rwMutex: Semaphore = new Semaphore(1)
	private readonly keyMutex: Semaphore = new Semaphore(1)
	private readonly initMutex: Semaphore = new Semaphore(1)
	private readonly modMutex: Semaphore = new Semaphore(1)

	public readonly uncachedKeys: string[] = []

	public readonly version: number = 1
	public readonly fallbackMmkvId: string = `securestore.fallback.v${this.version}.mmkv`
	public readonly secureStoreFileName: string = `securestore.v${this.version}.bin`
	public readonly secureStoreKeyEncryptionKey: string = `encryptionKey.v${this.version}`
	public readonly secureStoreFile: FileSystem.File = new FileSystem.File(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				this.secureStoreFileName
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document.uri, this.secureStoreFileName)
		})
	)

	public constructor() {
		if (!process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"]) {
			throw new Error(
				"Missing EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY environment variable for SecureStore fallback MMKV encryption key"
			)
		}

		const mmkvDirectory = new FileSystem.Directory(
			Platform.select({
				ios: FileSystem.Paths.join(
					FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
					"mmkv"
				),
				default: FileSystem.Paths.join(FileSystem.Paths.document.uri, "mmkv")
			})
		)

		if (!mmkvDirectory.exists) {
			mmkvDirectory.create({
				intermediates: true,
				idempotent: true
			})
		}

		this.mmkv = createMMKV({
			id: this.fallbackMmkvId,
			mode: "single-process",
			encryptionKey: process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"],
			path: normalizeFilePathForSdk(mmkvDirectory.uri),
			readOnly: false
		})
	}

	private async waitForInit(): Promise<void> {
		while (!this.initDone) {
			await this.init()
		}
	}

	public async init(): Promise<void> {
		const result = await run(async defer => {
			await this.initMutex.acquire()

			defer(() => {
				this.initMutex.release()
			})

			const [encryptionKey, current] = await Promise.all([this.getEncryptionKey(), (await this.read()) ?? {}])

			for (const [key, value] of Object.entries(current)) {
				if (this.uncachedKeys.includes(key)) {
					continue
				}

				cache.secureStore.set(key, value)

				events.emit("secureStoreChange", {
					key,
					value
				})
			}

			this.initDone = true

			return {
				encryptionKey,
				current
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	private async isAvailable(): Promise<boolean> {
		if (this.available !== null) {
			return this.available
		}

		try {
			this.available = await ExpoSecureStore.isAvailableAsync()
		} catch {
			this.available = false
		}

		return this.available
	}

	private async getEncryptionKey(): Promise<string> {
		const result = await run(async defer => {
			await this.keyMutex.acquire()

			defer(() => {
				this.keyMutex.release()
			})

			if (this.encryptionKey !== null) {
				return this.encryptionKey
			}

			const available = await this.isAvailable()

			if (!available) {
				this.encryptionKey = this.mmkv.getString(this.secureStoreKeyEncryptionKey) ?? null

				if (!this.encryptionKey) {
					this.encryptionKey = crypto.randomBytes(32).toString("hex")

					this.mmkv.set(this.secureStoreKeyEncryptionKey, this.encryptionKey)
				}

				return this.encryptionKey
			}

			this.encryptionKey = await ExpoSecureStore.getItemAsync(this.secureStoreKeyEncryptionKey)

			if (!this.encryptionKey) {
				this.encryptionKey = crypto.randomBytes(32).toString("hex")

				await ExpoSecureStore.setItemAsync(this.secureStoreKeyEncryptionKey, this.encryptionKey)
			}

			return this.encryptionKey
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	private async read(): Promise<Record<string, unknown> | null> {
		const result = await run(async defer => {
			if (this.readCache) {
				return this.readCache
			}

			await this.rwMutex.acquire()

			defer(() => {
				this.rwMutex.release()
			})

			if (!this.secureStoreFile.exists || this.secureStoreFile.size === 0) {
				return null
			}

			const [encryptionKey, bytes] = await Promise.all([this.getEncryptionKey(), this.secureStoreFile.bytes()])
			const cipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), bytes.subarray(0, 12))

			cipher.setAuthTag(bytes.subarray(bytes.length - 16))

			const decrypted = cipher.update(bytes.subarray(12, bytes.length - 16))
			const final = cipher.final()

			return unpack(Buffer.concat([decrypted, final])) as Record<string, unknown>
		})

		if (!result.success) {
			console.error("SecureStore: Error reading secure store:", result.error)

			return null
		}

		this.readCache = result.data

		return result.data
	}

	private async write(data: Record<string, unknown>): Promise<void> {
		const result = await run(async defer => {
			await this.rwMutex.acquire()

			defer(() => {
				this.rwMutex.release()
			})

			const encryptionKey = await this.getEncryptionKey()
			const iv = crypto.randomBytes(12)
			const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv)
			const encrypted = cipher.update(pack(data))
			const final = cipher.final()
			const authTag = cipher.getAuthTag()

			this.secureStoreFile.write(new Uint8Array(Buffer.concat([iv, encrypted, final, authTag])))

			this.readCache = data
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async set(key: string, value: unknown): Promise<void> {
		await this.waitForInit()

		const result = await run(async defer => {
			await this.modMutex.acquire()

			defer(() => {
				this.modMutex.release()
			})

			const current = this.readCache ?? (await this.read()) ?? {}
			const modified = {
				...current,
				[key]: value
			}

			await this.write(modified)

			cache.secureStore.set(key, value)

			events.emit("secureStoreChange", {
				key,
				value
			})
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async get<T>(key: string): Promise<T | null> {
		await this.waitForInit()

		const result = await run(async defer => {
			await this.modMutex.acquire()

			defer(() => {
				this.modMutex.release()
			})

			const current = this.readCache ?? (await this.read()) ?? {}
			const value = current[key]

			if (value == null) {
				return null
			}

			cache.secureStore.set(key, value)

			return value as T
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async remove(key: string): Promise<void> {
		await this.waitForInit()

		const result = await run(async defer => {
			await this.modMutex.acquire()

			defer(() => {
				this.modMutex.release()
			})

			const current = this.readCache ?? (await this.read()) ?? {}

			const modified = { ...current }

			delete modified[key]

			await this.write(modified)

			cache.secureStore.delete(key)

			events.emit("secureStoreRemove", {
				key
			})
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async clear(): Promise<void> {
		await this.waitForInit()

		const result = await run(async defer => {
			await this.modMutex.acquire()

			defer(() => {
				this.modMutex.release()
			})

			await this.rwMutex.acquire()

			defer(() => {
				this.rwMutex.release()
			})

			this.readCache = null
			this.secureStoreFile.delete()

			cache.secureStore.clear()

			events.emit("secureStoreClear")
		})

		if (!result.success) {
			throw result.error
		}
	}
}

const secureStore = new SecureStore()

const useSecureStoreFlushMutex: Semaphore = new Semaphore(1)

export function useSecureStore<T>(key: string, initialValue: T): [T, (fn: T | ((prev: T) => T)) => void] {
	const fromCache = cache.secureStore.get(key)
	const [state, setState] = useState<T>(fromCache ?? initialValue)
	const didRetrieveRef = useRef<boolean>(false)

	const flush = useCallback(
		async (before: T, now: T) => {
			const result = await run(async defer => {
				await useSecureStoreFlushMutex.acquire()

				defer(() => {
					useSecureStoreFlushMutex.release()
				})

				await secureStore.set(key, now)
			})

			if (!result.success) {
				console.error("Error setting value in secureStore:", result.error)

				setState(before)
			}
		},
		[key]
	)

	const retrieve = useCallback(async () => {
		if (didRetrieveRef.current) {
			return
		}

		didRetrieveRef.current = true

		const result = await run(async defer => {
			await useSecureStoreFlushMutex.acquire()

			defer(() => {
				useSecureStoreFlushMutex.release()
			})

			const value = await secureStore.get<T>(key)

			if (value !== null && !isEqual(value, state)) {
				setState(value)
			}
		})

		if (!result.success) {
			console.error("Error fetching value from secureStore:", result.error)

			didRetrieveRef.current = false
		}
	}, [key, state])

	const set = useCallback(
		(fn: T | ((prev: T) => T)): void => {
			const before = state
			const now = typeof fn === "function" ? (fn as (prev: T) => T)(before) : fn

			setState(now)
			flush(before, now)
		},
		[state, flush]
	)

	useEffect(() => {
		retrieve()

		const { cleanup } = runEffect(defer => {
			const secureStoreChangeSubscription = events.subscribe("secureStoreChange", payload => {
				if (payload.key === key) {
					setState(payload.value)
				}
			})

			defer(() => {
				secureStoreChangeSubscription.remove()
			})

			const secureStoreRemoveSubscription = events.subscribe("secureStoreRemove", payload => {
				if (payload.key === key) {
					setState(initialValue)
				}
			})

			defer(() => {
				secureStoreRemoveSubscription.remove()
			})

			const secureStoreClearSubscription = events.subscribe("secureStoreClear", () => {
				setState(initialValue)
			})

			defer(() => {
				secureStoreClearSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [key, initialValue, retrieve])

	return [state, set]
}

export default secureStore
