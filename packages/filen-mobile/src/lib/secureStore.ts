import * as ExpoSecureStore from "expo-secure-store"
import { createMMKV, type MMKV } from "react-native-mmkv"
import * as FileSystem from "expo-file-system"
import { ensureDirectory } from "@/lib/fsUtils"
import crypto from "crypto"
import { serialize, deserialize } from "@/lib/serializer"
import { run, runOrThrow, Semaphore, KeyedSemaphores } from "@filen/shared"
import { useRef, useEffect, useCallback, useState } from "react"
import cache from "@/lib/cache"
import events from "@/lib/events"
import { Buffer } from "react-native-quick-crypto"
import { isEqual } from "es-toolkit"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { SECURE_STORE_DIRECTORY, MMKV_DIRECTORY } from "@/lib/storageRoots"
import { sealAesGcm, openAesGcm } from "@/lib/aesGcm"
import useEffectOnce from "@/hooks/useEffectOnce"
import logger from "@/lib/logger"

// kSecAttrAccessibleAfterFirstUnlock — Apple's recommended class for background access. The
// expo-secure-store default (kSecAttrAccessibleWhenUnlocked) makes the key unreadable the
// moment the screen locks, which is exactly when BGProcessingTask runs fire — every
// locked-device background sync died at setup with errSecInteractionNotAllowed. The key
// stays hardware-protected until the first unlock after boot. Android ignores this option.
const ENCRYPTION_KEY_KEYCHAIN_OPTIONS: ExpoSecureStore.SecureStoreOptions = {
	keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK
}

export type SecureStoreKeyChange = { type: "set"; value: unknown } | { type: "removed" }

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
	// Renamed from "encryptionKey" ONCE (2026-06-12): keychain items keep their accessibility
	// class forever — expo-secure-store's duplicate-item path is a SecItemUpdate whose update
	// dictionary carries ONLY kSecValueData (SecureStoreModule.swift update()), so a same-name
	// item written under the old kSecAttrAccessibleWhenUnlocked default could never be moved to
	// AFTER_FIRST_UNLOCK (proven on-device). A fresh name guarantees every install's key is
	// born with the right class via SecItemAdd. Pre-prod: installs with the old item simply
	// re-login; no migration.
	public readonly secureStoreKeyEncryptionKey: string = "encryptionKeyAfu"
	public readonly secureStoreFile: FileSystem.File = new FileSystem.File(
		FileSystem.Paths.join(SECURE_STORE_DIRECTORY.uri, this.secureStoreFileName)
	)

	private directoriesEnsured = false

	private ensureDirectories(): void {
		if (this.directoriesEnsured) {
			return
		}

		ensureDirectory(this.secureStoreFile.parentDirectory)

		ensureDirectory(MMKV_DIRECTORY)

		this.directoriesEnsured = true
	}

	public constructor() {
		if (!process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"]) {
			throw new Error(
				"Missing EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY environment variable for SecureStore fallback MMKV encryption key"
			)
		}

		// Best-effort at construction (runs at module import time): a synchronous expo-file-system
		// failure here (disk full, sandbox path not yet available, OS permissions) must not crash
		// module evaluation. directoriesEnsured stays false on failure so init()/getEncryptionKey()/
		// read()/write()/set()/remove()/clear() retry inside their runOrThrow() wrappers, where a persistent
		// failure surfaces as a normal rejection instead.
		try {
			this.ensureDirectories()
		} catch (e) {
			logger.warn("secure-store", "Deferred directory creation failed at module init", { error: e })
		}

		this.mmkv = createMMKV({
			id: this.fallbackMmkvId,
			mode: "single-process",
			encryptionKey: process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"],
			path: normalizeFilePathForSdk(MMKV_DIRECTORY.uri),
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
		if (this.initDone) {
			return
		}

		await runOrThrow(() =>
			this.initMutex.withPermit(async () => {
				// Re-check after acquiring the mutex: a concurrent caller may have completed init while we
				// waited. Without this guard a second init() (e.g. setup()'s Promise.all call, after
				// auth.isAuthed() already initialized the store) re-reads the cache and re-emits a
				// secureStoreChange for every stored key — a redundant O(n) pass.
				if (this.initDone) {
					return
				}

				this.ensureDirectories()

				// init() uses the STRICT readExisting() (not the degrading read()) so a transient IO
				// failure propagates through this runOrThrow() wrapper and init() rejects (retry next launch
				// against the intact file). An UNDECRYPTABLE store no longer rejects — loadFromDisk's
				// recovery ladder restores a valid backup or resets to empty (logged-out boot).
				const [, current] = await Promise.all([this.getEncryptionKey(), (await this.readExisting()) ?? {}])

				for (const key in current) {
					const value = current[key]

					cache.secureStore.set(key, value)

					events.emit("secureStoreChange", {
						key,
						value
					})
				}

				this.initDone = true
			})
		)
	}

	private async isAvailable(): Promise<boolean> {
		if (this.available !== null) {
			return this.available
		}

		try {
			this.available = await ExpoSecureStore.isAvailableAsync()
		} catch (e) {
			logger.warn("secure-store", "ExpoSecureStore availability check threw — using MMKV fallback", { error: e })
			this.available = false
		}

		return this.available
	}

	private async getEncryptionKey(): Promise<string> {
		return await runOrThrow(() =>
			this.keyMutex.withPermit(async () => {
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
					logger.warn(
						"secure-store",
						"Encryption key not found in keychain — generating new key (first-install or keychain loss)"
					)
					this.encryptionKey = crypto.randomBytes(32).toString("hex")

					await ExpoSecureStore.setItemAsync(
						this.secureStoreKeyEncryptionKey,
						this.encryptionKey,
						ENCRYPTION_KEY_KEYCHAIN_OPTIONS
					)
				}

				return this.encryptionKey
			})
		)
	}

	// Pure AES-256-GCM decrypt + deserialize of a full store payload (12-byte IV ++ ciphertext ++
	// 16-byte authTag). Throws if the buffer is too short, the auth tag fails (tampered/corrupt/
	// wrong key), or the plaintext does not deserialize. The thrown error is the integrity gate
	// the backup-recovery scan relies on to discard bad candidates.
	private decryptStorePayload(bytes: Uint8Array, encryptionKey: string): Record<string, unknown> {
		if (bytes.length < 12 + 16) {
			throw new Error("SecureStore: payload too short to contain IV + authTag")
		}

		return deserialize<Record<string, unknown>>(openAesGcm(Buffer.from(encryptionKey, "hex"), bytes, 0))
	}

	// Enumerate the destination's parent directory and delete every .securestore.tmp.* /
	// .securestore.bak.* staging sibling, leaving the canonical destination itself untouched.
	// Best-effort: a failed listing or a failed per-entry delete is swallowed (orphans are
	// harmless). Shared by adopt() and the reset path of loadFromDisk() (post-read tidy-up) and clear()
	// (logout wipe). Post-read it only ever runs AFTER a confirmed-valid decrypt or a reset, so it can
	// never remove the only surviving copy.
	private deleteStagingSiblings(): void {
		try {
			const destinationUri = this.secureStoreFile.uri

			for (const entry of this.secureStoreFile.parentDirectory.list()) {
				if (entry instanceof FileSystem.Directory) {
					continue
				}

				if (entry.uri === destinationUri) {
					continue
				}

				if (entry.name.startsWith(".securestore.tmp.") || entry.name.startsWith(".securestore.bak.")) {
					try {
						entry.delete()
					} catch {
						// Orphaned sibling; harmless.
					}
				}
			}
		} catch {
			// Listing failed; the orphans are harmless and will be cleaned on a later successful read/clear.
		}
	}

	// Cross-process crash-recovery scan (finding 52). write() commits in two non-atomic moveSync
	// steps; a hard kill between them leaves the only intact copy under a UUID-named
	// .securestore.bak.* sibling. When the destination is missing/zero-length, enumerate the
	// backups, pick the newest by mtime, restore it into the canonical destination, and validate
	// by decrypt (the AES-256-GCM auth tag is the integrity gate — a candidate that fails to
	// decrypt is discarded and the next is tried). Returns the recovered store on success, or null
	// when no valid backup exists. Never throws (a failed candidate is skipped, a failed restore
	// is best-effort and the next candidate is attempted).
	private recoverDestinationFromBackup(encryptionKey: string): Record<string, unknown> | null {
		const destinationUri = this.secureStoreFile.uri
		const parentDirectory = this.secureStoreFile.parentDirectory

		let entries: (FileSystem.File | FileSystem.Directory)[]

		try {
			entries = parentDirectory.list()
		} catch (e) {
			logger.warn("secure-store", "Backup recovery: parent directory listing failed", { error: e })
			return null
		}

		const candidates = entries
			.filter((entry): entry is FileSystem.File => entry instanceof FileSystem.File && entry.name.startsWith(".securestore.bak."))
			.map(file => ({
				file,
				mtime: file.lastModified ?? 0
			}))
			// Newest first — the most recent backup is the freshest committed payload.
			.sort((a, b) => b.mtime - a.mtime)

		for (const { file } of candidates) {
			let data: Record<string, unknown>

			try {
				if (!file.exists || file.size === 0) {
					continue
				}

				// Integrity gate: a candidate that fails to decrypt is corrupt/foreign — skip it.
				data = this.decryptStorePayload(file.bytesSync(), encryptionKey)
			} catch {
				continue
			}

			try {
				// Promote the validated backup into the canonical destination. The destination is
				// missing/zero here, so a plain move is safe. Use fresh handles so the shared
				// this.secureStoreFile identity is never mutated.
				new FileSystem.File(file.uri).moveSync(new FileSystem.File(destinationUri))
			} catch (e) {
				// Restore failed — leave the backup in place for the next attempt and continue.
				logger.warn("secure-store", "Backup recovery: failed to promote backup to destination", { backupUri: file.uri, error: e })
				continue
			}

			return data
		}

		return null
	}

	// Takes a confirmed-valid store as the live one, then discards the stale tmp/bak siblings.
	private adopt(data: Record<string, unknown>): Record<string, unknown> {
		this.readCache = data

		this.deleteStagingSiblings()

		return data
	}

	// Shared destination loader. Returns the decrypted store (caching it) on a present+valid
	// destination; on an UNDECRYPTABLE destination runs the recovery ladder (drop dead file →
	// promote newest valid same-key .bak → reset to empty); attempts the same backup recovery
	// when the destination is missing/zero-length. Returns null when the store is empty after
	// the ladder (genuinely absent, or reset — caller proceeds logged-out). THROWS only on
	// transient IO read failures — the surviving core of finding 51, so set()'s merge base
	// never collapses on a hiccup. Callers decide whether to swallow (read() → get()) or
	// propagate (readExisting() → set()/remove()/init()).
	private loadFromDisk(encryptionKey: string): Record<string, unknown> | null {
		this.ensureDirectories()

		const destinationPresent = this.secureStoreFile.exists && this.secureStoreFile.size > 0

		if (destinationPresent) {
			// IO read failures stay OUTSIDE the try below: they are transient and must keep
			// throwing — the surviving core of finding 51 (set()'s read-modify-write merge
			// base must never collapse to {} on a hiccup). Only the deterministic crypto
			// verdict participates in the recovery ladder.
			const bytes = this.secureStoreFile.bytesSync()

			try {
				return this.adopt(this.decryptStorePayload(bytes, encryptionKey))
			} catch (e) {
				// RECOVERY LADDER (2026-06-12, supersedes the old throw-forever): a GCM
				// auth-tag failure is deterministic — the payload is cryptographically dead
				// under the live key (renamed/lost key, disk corruption, restore mixing) and
				// no retry can ever succeed; the old reject path was a permanent brick
				// (setup-failed retry loop). Ladder: (1) drop the dead destination,
				// (2) promote the newest valid same-key .bak — an interrupted write's backup
				// is the freshest committed state, zero loss for the crash case, (3) reset to
				// a fresh empty store: the cloud is the source of truth and everything in
				// here is restored by re-login. A failed delete keeps the old conservative
				// throw (cannot recover safely this boot — retry next launch).
				logger.error("secure-store", "Destination payload failed AES-GCM authentication — entering recovery ladder", { error: e })

				try {
					this.secureStoreFile.delete()
				} catch {
					throw e
				}

				const recovered = this.recoverDestinationFromBackup(encryptionKey)

				if (recovered !== null) {
					return this.adopt(recovered)
				}

				logger.error("secure-store", "No recoverable backup found — store reset to empty, re-login required")

				this.deleteStagingSiblings()

				return null
			}
		}

		// Destination is missing/zero-length. Before concluding the store is empty, attempt to
		// recover from an orphaned backup left by an interrupted write().
		const recovered = this.recoverDestinationFromBackup(encryptionKey)

		// Genuinely absent when null: no destination, no recoverable backup.
		return recovered !== null ? this.adopt(recovered) : null
	}

	// Non-destructive read used by get(): degrades a read/decrypt/IO failure to null (logs only).
	// NEVER use this as the read-modify-write merge base — a degraded null there would clobber a
	// present-but-unreadable store (finding 51); set()/remove()/init() use readExisting() instead.
	private async read(): Promise<Record<string, unknown> | null> {
		try {
			return await this.readExisting()
		} catch (e) {
			logger.error("secure-store", "Read degraded to null after IO/decrypt failure", { error: e })

			return null
		}
	}

	// Strict read used as the read-modify-write merge base by set()/remove() and by init(). Returns
	// null ONLY when the store is genuinely absent/zero-length (and no backup is recoverable), and
	// THROWS on any decrypt/IO/deserialize failure of a present payload. This is what prevents a
	// transient read failure from collapsing the merge base to {} and destructively overwriting the
	// whole encrypted store with the single key being written (finding 51).
	private async readExisting(): Promise<Record<string, unknown> | null> {
		return await runOrThrow(async defer => {
			if (this.readCache) {
				return this.readCache
			}

			await this.rwMutex.acquire()

			defer(() => {
				this.rwMutex.release()
			})

			if (this.readCache) {
				return this.readCache
			}

			const encryptionKey = await this.getEncryptionKey()

			return this.loadFromDisk(encryptionKey)
		})
	}

	private async write(data: Record<string, unknown>): Promise<void> {
		await runOrThrow(() =>
			this.rwMutex.withPermit(async () => {
				this.ensureDirectories()

				const encryptionKey = await this.getEncryptionKey()
				// IV ++ ciphertext ++ authTag, pinned by the hardening suite against an independent decryptor.
				const payload = sealAesGcm(Buffer.from(encryptionKey, "hex"), Buffer.from(serialize(data), "utf-8"))

				// Stage the new payload in the SAME directory as the destination so the final
				// move is an atomic intra-volume rename (not a cross-volume copy, which would
				// widen the crash window). We deliberately move the OLD file ASIDE to a backup
				// before promoting the staged payload — not to dodge an overwrite limitation
				// (File.move() does take a RelocationOptions { overwrite }, but a single
				// overwriting rename would still leave a window with zero intact copies if the
				// process dies mid-rename) — so that on any failure during the swap the backup
				// can be restored and the store never reaches a state with zero copies.
				const parentDirectory = this.secureStoreFile.parentDirectory
				const destinationUri = this.secureStoreFile.uri
				const tmpFile = new FileSystem.File(parentDirectory, `.securestore.tmp.${crypto.randomUUID()}`)
				const backupUri = FileSystem.Paths.join(parentDirectory.uri, `.securestore.bak.${crypto.randomUUID()}`)

				let backedUp = false
				let promoted = false

				try {
					tmpFile.write(payload)

					// Move the existing store aside to the backup before clearing the destination.
					// Use a fresh handle so the shared this.secureStoreFile.uri is never mutated by move().
					if (this.secureStoreFile.exists) {
						await new FileSystem.File(destinationUri).move(new FileSystem.File(backupUri))

						backedUp = true
					}

					// Promote the staged payload into place. Use a fresh destination handle so the
					// shared this.secureStoreFile instance keeps its identity.
					await tmpFile.move(new FileSystem.File(destinationUri))

					// The new payload is now the live store. move() has mutated tmpFile.uri to the
					// destination, so from here the catch block must NOT delete tmpFile.
					promoted = true
					this.readCache = data

					// Best-effort: discard the backup now that the new payload is live. A failure
					// here only orphans the backup (harmless) and must never surface as a write
					// failure or reach the catch — the store is already safely committed on disk.
					if (backedUp) {
						try {
							const backupFile = new FileSystem.File(backupUri)

							if (backupFile.exists) {
								backupFile.delete()
							}
						} catch {
							// Orphaned backup; harmless.
						}
					}
				} catch (e) {
					// If the swap failed BEFORE promotion (destination cleared but new payload not
					// yet in place), restore the backup so the destination is never left empty —
					// credentials must survive a failed write.
					if (!promoted && backedUp && !this.secureStoreFile.exists) {
						const backupFile = new FileSystem.File(backupUri)

						if (backupFile.exists) {
							try {
								backupFile.moveSync(new FileSystem.File(destinationUri))
							} catch (restoreErr) {
								// Best-effort restore; the backup is preserved below for manual recovery.
								logger.error("secure-store", "Write swap failed AND backup restore failed — destination may be empty", {
									error: e,
									restoreError: String(restoreErr)
								})
							}
						}
					}

					// Only delete the staged tmp when it was NOT promoted — after a successful move
					// tmpFile.uri points at the live store, so deleting it would wipe credentials.
					if (!promoted && tmpFile.exists) {
						tmpFile.delete()
					}

					// Discard the backup only once the destination is safely back in place — never
					// when the destination is still missing, or the only surviving copy would be lost.
					const backupFile = new FileSystem.File(backupUri)

					if (this.secureStoreFile.exists && backupFile.exists) {
						backupFile.delete()
					}

					throw e
				}
			})
		)
	}

	public async set(key: string, value: unknown): Promise<void> {
		await this.waitForInit()

		await runOrThrow(() =>
			this.modMutex.withPermit(async () => {
				this.ensureDirectories()

				// readExisting() (not read()) so a present-but-unreadable store rejects here WITHOUT ever
				// reaching write({ [key]: value }) — which would destroy every other stored secret (finding 51).
				const current = this.readCache ?? (await this.readExisting()) ?? {}
				// `current` mirrors disk, so an unchanged value is already persisted: skip the whole-store reseal.
				if (!(Object.hasOwn(current, key) && isEqual(current[key], value))) {
					// Fresh merged object (never mutate `current`): a failed write() must leave
					// readCache consistent with what is actually on disk. The spread stays —
					// benchmarked AGAINST Object.assign at 10k/100k-entry stores and the spread
					// won (+8%/+42% regressions with assign; engines fast-path object spread).
					const modified = {
						...current,
						[key]: value
					}

					await this.write(modified)
				}

				cache.secureStore.set(key, value)

				events.emit("secureStoreChange", {
					key,
					value
				})
			})
		)
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

		await runOrThrow(() =>
			this.modMutex.withPermit(async () => {
				this.ensureDirectories()

				// readExisting() (not read()) so a present-but-unreadable store rejects here WITHOUT ever
				// reaching write({ ...rest }) — which would destroy every other stored secret (finding 51).
				const current = this.readCache ?? (await this.readExisting()) ?? {}
				// An absent key leaves nothing to rewrite.
				if (Object.hasOwn(current, key)) {
					// Single-pass copy skipping the removed key — the rest-destructuring it
					// replaces paid the destructuring machinery on top of the copy. Store keys
					// are plain strings (serialized JSON), so for-in covers the full domain.
					const modified: Record<string, unknown> = {}

					for (const currentKey in current) {
						if (currentKey !== key) {
							modified[currentKey] = current[currentKey]
						}
					}

					await this.write(modified)
				}

				cache.secureStore.delete(key)

				events.emit("secureStoreRemove", {
					key
				})
			})
		)
	}

	public async clear(): Promise<void> {
		await this.waitForInit()

		await runOrThrow(async defer => {
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

			// Logout is a WIPE: deleting only the destination is not enough. A write() that hard-crashed
			// mid-swap can leave an intact prior-credentials copy under a .securestore.bak.* sibling (and a
			// half-written .securestore.tmp.*). If those survive clear(), the next launch's backup-recovery
			// scan (recoverDestinationFromBackup) would RESURRECT the just-wiped secrets. Sweep every
			// staging sibling unconditionally — including when the destination is already gone — so no
			// on-disk secret material outlives logout.
			this.deleteStagingSiblings()

			cache.secureStore.clear()

			events.emit("secureStoreClear")
		})
	}

	/**
	 * Watches a single key; a whole-store clear is delivered as "removed". Returns the unsubscribe.
	 */
	public subscribeKey(key: string, listener: (change: SecureStoreKeyChange) => void): () => void {
		const changeSubscription = events.subscribe("secureStoreChange", payload => {
			if (payload.key === key) {
				listener({
					type: "set",
					value: payload.value
				})
			}
		})

		const removeSubscription = events.subscribe("secureStoreRemove", payload => {
			if (payload.key === key) {
				listener({
					type: "removed"
				})
			}
		})

		const clearSubscription = events.subscribe("secureStoreClear", () => {
			listener({
				type: "removed"
			})
		})

		return () => {
			changeSubscription.remove()
			removeSubscription.remove()
			clearSubscription.remove()
		}
	}
}

const secureStore = new SecureStore()

// Non-pruning: every hook on a key holds the same instance in a ref.
const secureStoreFlushMutexes = new KeyedSemaphores()

/**
 * Fire-and-forget write for callers that never read the key: subscribers still see the change, but
 * the caller holds no subscription of its own. Shares the hooks' per-key flush mutex so ordering is kept.
 */
export function setSecureStoreValue<T>(key: string, value: T): void {
	;(async () => {
		const result = await run(() => secureStoreFlushMutexes.for(key).withPermit(() => secureStore.set(key, value)))

		if (!result.success) {
			logger.error("secure-store", "useSecureStore: set failed", { key, error: result.error })
		}
	})()
}

export function useSecureStore<T>(key: string, initialValue: T): [T, (fn: T | ((prev: T) => T)) => void] {
	const [state, setState] = useState<T>(() => (cache.secureStore.get(key) as T | undefined) ?? initialValue)
	const lastValueRef = useRef<T>(state)
	const flushMutexRef = useRef<Semaphore>(secureStoreFlushMutexes.for(key))
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
		const result = await run(() =>
			flushMutexRef.current.withPermit(async () => {
				const value = await secureStore.get<T>(key)

				if (value !== null) {
					setStateChecked(value)
				}
			})
		)

		if (!result.success) {
			logger.error("secure-store", "useSecureStore: retrieve failed", { key, error: result.error })
		}
	}

	const set = useCallback(
		(fn: T | ((prev: T) => T)): void => {
			isLocalUpdateRef.current = true
			;(async () => {
				const result = await run(() =>
					flushMutexRef.current.withPermit(async () => {
						// For the functional form re-read the freshest persisted value as the merge base
						// (inside the flush mutex, so a concurrent instance's prior write is already
						// committed) instead of this instance's optimistic lastValueRef. Otherwise two
						// overlapping cross-instance sets on the same key compute from a stale base and
						// the loser silently clobbers the winner — the self-echo flag (isLocalUpdateRef)
						// drops the winner's secureStoreChange echo while this set() is in flight, so
						// lastValueRef never catches up (CU-06). The direct-value form needs no re-read.
						const now =
							typeof fn === "function" ? (fn as (prev: T) => T)((await secureStore.get<T>(key)) ?? lastValueRef.current) : fn

						setStateChecked(now)

						await secureStore.set(key, now)
					})
				)

				isLocalUpdateRef.current = false

				if (!result.success) {
					logger.error("secure-store", "useSecureStore: set failed", { key, error: result.error })
				}
			})()
		},
		[key, setStateChecked]
	)

	useEffect(() => {
		initialValueRef.current = initialValue
	}, [initialValue])

	useEffectOnce(() => {
		retrieve().catch(err => logger.error("secure-store", "useSecureStore: initial retrieve threw", { key, error: err }))
	})

	useEffect(() => {
		return secureStore.subscribeKey(key, change => {
			if (isLocalUpdateRef.current) {
				return
			}

			setStateChecked(change.type === "set" ? (change.value as T) : initialValueRef.current)
		})
	}, [key, setStateChecked])

	return [state, set]
}

export default secureStore
