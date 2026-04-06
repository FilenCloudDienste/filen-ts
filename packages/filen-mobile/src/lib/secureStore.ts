import * as ExpoSecureStore from "expo-secure-store"
import { createMMKV, type MMKV } from "react-native-mmkv"
import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import crypto from "crypto"
import { serialize, deserialize } from "@/lib/serializer"
import { run, Semaphore, runEffect } from "@filen/utils"
import { useRef, useEffect, useCallback, useState } from "react"
import cache from "@/lib/cache"
import events from "@/lib/events"
import { Buffer } from "react-native-quick-crypto"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import isEqual from "react-fast-compare"
import { normalizeFilePathForSdk } from "@/lib/utils"
import useEffectOnce from "@/hooks/useEffectOnce"

export const VERSION = 1

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

	public readonly fallbackMmkvId: string = "securestore.fallback.mmkv"
	public readonly secureStoreFileName: string = "securestore.bin"
	public readonly secureStoreKeyEncryptionKey: string = "encryptionKey"
	public readonly secureStoreFile: FileSystem.File = new FileSystem.File(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				"secureStore",
				`v${VERSION}`,
				this.secureStoreFileName
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document, "secureStore", `v${VERSION}`, this.secureStoreFileName)
		})
	)
	public readonly mmkvDirectory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				"mmkv",
				`v${VERSION}`
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document, "mmkv", `v${VERSION}`)
		})
	)

	private directoriesEnsured = false

	private ensureDirectories(): void {
		if (this.directoriesEnsured) {
			return
		}

		if (!this.secureStoreFile.parentDirectory.exists) {
			this.secureStoreFile.parentDirectory.create({
				idempotent: true,
				intermediates: true
			})
		}

		if (!this.mmkvDirectory.exists) {
			this.mmkvDirectory.create({
				idempotent: true,
				intermediates: true
			})
		}

		this.directoriesEnsured = true
	}

	public constructor() {
		if (!process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"]) {
			throw new Error(
				"Missing EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY environment variable for SecureStore fallback MMKV encryption key"
			)
		}

		this.ensureDirectories()

		this.mmkv = createMMKV({
			id: this.fallbackMmkvId,
			mode: "single-process",
			encryptionKey: process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"],
			path: normalizeFilePathForSdk(this.mmkvDirectory.uri),
			readOnly: false
		})
	}

	private async waitForInit(): Promise<void> {
		if (this.initDone) {
			return
		}

		await this.init()
	}

	public async init(): Promise<void> {
		const result = await run(async defer => {
			await this.initMutex.acquire()

			defer(() => {
				this.initMutex.release()
			})

			this.ensureDirectories()

			const [encryptionKey, current] = await Promise.all([this.getEncryptionKey(), (await this.read()) ?? {}])

			for (const [key, value] of Object.entries(current)) {
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

			this.ensureDirectories()

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

			this.ensureDirectories()

			if (!this.secureStoreFile.exists || this.secureStoreFile.size === 0) {
				return null
			}

			const [encryptionKey, bytes] = await Promise.all([this.getEncryptionKey(), this.secureStoreFile.bytes()])
			const cipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), bytes.subarray(0, 12))

			cipher.setAuthTag(bytes.subarray(bytes.length - 16))

			const decrypted = cipher.update(bytes.subarray(12, bytes.length - 16))
			const final = cipher.final()

			const data = deserialize(Buffer.concat([decrypted, final])) as Record<string, unknown>

			this.readCache = data

			return data
		})

		if (!result.success) {
			console.error("SecureStore: Error reading secure store:", result.error)

			return null
		}

		return result.data
	}

	private async write(data: Record<string, unknown>): Promise<void> {
		const result = await run(async defer => {
			await this.rwMutex.acquire()

			defer(() => {
				this.rwMutex.release()
			})

			this.ensureDirectories()

			const encryptionKey = await this.getEncryptionKey()
			const iv = crypto.randomBytes(12)
			const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv)
			const encrypted = cipher.update(Buffer.from(serialize(data)))
			const final = cipher.final()
			const authTag = cipher.getAuthTag()

			const tmpFile = new FileSystem.File(FileSystem.Paths.join(FileSystem.Paths.cache, `.securestore.tmp.${crypto.randomUUID()}`))

			try {
				tmpFile.write(new Uint8Array(Buffer.concat([iv, encrypted, final, authTag])))

				if (this.secureStoreFile.exists) {
					this.secureStoreFile.delete()
				}

				tmpFile.move(this.secureStoreFile)

				this.readCache = data
			} catch (e) {
				if (tmpFile.exists) {
					tmpFile.delete()
				}

				throw e
			}
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

			this.ensureDirectories()

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

		const current = this.readCache ?? (await this.read()) ?? {}
		const value = current[key]

		if (value == null) {
			return null
		}

		cache.secureStore.set(key, value)

		// Trusted cast: callers are responsible for using the correct type parameter
		return value as T
	}

	public async remove(key: string): Promise<void> {
		await this.waitForInit()

		const result = await run(async defer => {
			await this.modMutex.acquire()

			defer(() => {
				this.modMutex.release()
			})

			this.ensureDirectories()

			const current = this.readCache ?? (await this.read()) ?? {}
			const { [key]: _, ...modified } = current

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

			this.ensureDirectories()

			this.readCache = null

			if (this.secureStoreFile.exists) {
				this.secureStoreFile.delete()
			}

			cache.secureStore.clear()

			events.emit("secureStoreClear")
		})

		if (!result.success) {
			throw result.error
		}
	}
}

const secureStore = new SecureStore()

const useSecureStoreFlushMutex = new Map<string, Semaphore>()

function getSecureStoreFlushMutex(key: string): Semaphore {
	if (!useSecureStoreFlushMutex.has(key)) {
		useSecureStoreFlushMutex.set(key, new Semaphore(1))
	}

	return useSecureStoreFlushMutex.get(key) as Semaphore
}

export function useSecureStore<T>(key: string, initialValue: T): [T, (fn: T | ((prev: T) => T)) => void] {
	const [state, setState] = useState<T>(() => cache.secureStore.get(key) ?? initialValue)
	const lastValueRef = useRef<T>(state)
	const flushMutexRef = useRef<Semaphore>(getSecureStoreFlushMutex(key))
	const isLocalUpdateRef = useRef<boolean>(false)
	const initialValueRef = useRef<T>(initialValue)

	const setStateChecked = useCallback(
		(value: T) => {
			if (isEqual(value, lastValueRef.current)) {
				return
			}

			lastValueRef.current = value

			setState(value)
		},
		[setState]
	)

	const retrieve = async () => {
		const result = await run(async defer => {
			await flushMutexRef.current.acquire()

			defer(() => {
				flushMutexRef.current.release()
			})

			const value = await secureStore.get<T>(key)

			if (value !== null) {
				setStateChecked(value)
			}
		})

		if (!result.success) {
			console.error("Error fetching value from secureStore:", result.error)
		}
	}

	const set = (fn: T | ((prev: T) => T)): void => {
		;(async () => {
			const result = await run(async defer => {
				await flushMutexRef.current.acquire()

				defer(() => {
					flushMutexRef.current.release()
				})

				isLocalUpdateRef.current = true

				defer(() => {
					isLocalUpdateRef.current = false
				})

				const now = typeof fn === "function" ? (fn as (prev: T) => T)(lastValueRef.current) : fn

				setStateChecked(now)

				await secureStore.set(key, now)
			})

			if (!result.success) {
				console.error("Error setting value in secureStore:", result.error)

				return
			}
		})()
	}

	useEffect(() => {
		initialValueRef.current = initialValue
	}, [initialValue])

	useEffectOnce(() => {
		retrieve().catch(console.error)
	})

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const secureStoreChangeSubscription = events.subscribe("secureStoreChange", payload => {
				if (payload.key === key && !isLocalUpdateRef.current) {
					setStateChecked(payload.value)
				}
			})

			defer(() => {
				secureStoreChangeSubscription.remove()
			})

			const secureStoreRemoveSubscription = events.subscribe("secureStoreRemove", payload => {
				if (payload.key === key && !isLocalUpdateRef.current) {
					setStateChecked(initialValueRef.current)
				}
			})

			defer(() => {
				secureStoreRemoveSubscription.remove()
			})

			const secureStoreClearSubscription = events.subscribe("secureStoreClear", () => {
				if (!isLocalUpdateRef.current) {
					setStateChecked(initialValueRef.current)
				}
			})

			defer(() => {
				secureStoreClearSubscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [key, setStateChecked])

	return [state, set]
}

export default secureStore
