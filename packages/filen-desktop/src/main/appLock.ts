import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { type } from "arktype"
import type { DesktopLockAttempt, DesktopLockStatus } from "@filen/shared/desktop"
import { type AtomicFile, errorCode } from "./atomicFile.ts"
import { serialQueue } from "../shared/serial.ts"
import { removeIfUndecryptable, type VaultCipher } from "./sessionVault.ts"

// scrypt cost for new PINs: 32 MiB and roughly 50-100 ms per check on current hardware, off the main thread (libuv's
// pool). Stored with each hash, so raising them later only affects PINs set afterwards.
export const PIN_HASH_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const
const KEY_LENGTH = 32
const SALT_LENGTH = 16

// Wrong PINs: the first few are free (typos), then each further one doubles the wait, up to an hour. A 4-digit PIN
// then takes months to brute-force through the lock screen.
export const FREE_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 30 * 1000
export const BACKOFF_MAX_MS = 60 * 60 * 1000

// How long the window may stay hidden (or minimized) before the app locks itself.
export const LOCK_AFTER_HIDDEN_MS = 5 * 60 * 1000

// Whether a window out of sight since `hiddenAt` (null: in sight) has been so long enough to lock. By the clock, so time
// asleep counts; a clock set back counts as not yet.
export function hiddenLockDue(hiddenAt: number | null, now: number): boolean {
	return hiddenAt !== null && now - hiddenAt >= LOCK_AFTER_HIDDEN_MS
}

export interface PinHash {
	salt: Buffer
	hash: Buffer
	N: number
	r: number
	p: number
}

function derive(pin: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// scrypt needs 128 * N * r bytes; Node's default cap is exactly that at today's params.
		scrypt(pin, salt, KEY_LENGTH, { ...params, maxmem: 256 * params.N * params.r }, (error, key) => {
			if (error === null) {
				resolve(key)
			} else {
				reject(error)
			}
		})
	})
}

export async function hashPin(pin: string): Promise<PinHash> {
	const salt = randomBytes(SALT_LENGTH)

	return { salt, hash: await derive(pin, salt, PIN_HASH_PARAMS), ...PIN_HASH_PARAMS }
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
	const key = await derive(pin, stored.salt, stored)

	return key.length === stored.hash.length && timingSafeEqual(key, stored.hash)
}

// Failed attempts in a row and when the next one is accepted (epoch ms, 0: now).
export interface AttemptState {
	failures: number
	retryAt: number
}

export function backoffDelay(failures: number): number {
	return failures < FREE_ATTEMPTS ? 0 : Math.min(BACKOFF_BASE_MS * 2 ** (failures - FREE_ATTEMPTS), BACKOFF_MAX_MS)
}

// A wait longer than the failures can have earned means the clock went back since it was stored; it is cut to what
// they earn from now, once, so it can never become a window that keeps moving.
export function normalizeAttempts<T extends AttemptState>(state: T, now: number): T {
	const latest = now + backoffDelay(state.failures)

	return state.retryAt > latest ? { ...state, retryAt: latest } : state
}

export function failedAttempt(state: AttemptState, now: number): AttemptState {
	const failures = state.failures + 1
	const delay = backoffDelay(failures)

	return { failures, retryAt: delay === 0 ? 0 : now + delay }
}

export function retryAtOf(state: AttemptState, now: number): number | null {
	return state.retryAt > now ? state.retryAt : null
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/

// The params a stored record may carry: never weaker than today's floor, never so costly that an edited file makes
// main allocate unbounded memory (N 2^15-2^17, so at most 256 MiB with r 16).
const lockRecordSchema = type({
	version: "1",
	salt: base64,
	hash: base64,
	N: "32768 <= number.integer <= 131072",
	r: "8 <= number.integer <= 16",
	p: "1 <= number.integer <= 4",
	failures: "0 <= number.integer < 1000000",
	retryAt: "number.integer >= 0"
})

// The whole record (hash, salt, params and the backoff) is rewritten on every change: it is one small encrypted blob.
export interface LockRecord extends PinHash, AttemptState {}

// null: unusable (unparsable, out-of-range params, N not a power of two, a key of the wrong size).
export function parseLockRecord(data: string): LockRecord | null {
	let json: unknown

	try {
		json = JSON.parse(data)
	} catch {
		return null
	}

	const record = lockRecordSchema(json)

	if (record instanceof type.errors || (record.N & (record.N - 1)) !== 0) {
		return null
	}

	const salt = Buffer.from(record.salt, "base64")
	const hash = Buffer.from(record.hash, "base64")

	if (salt.length !== SALT_LENGTH || hash.length !== KEY_LENGTH) {
		return null
	}

	return { salt, hash, N: record.N, r: record.r, p: record.p, failures: record.failures, retryAt: record.retryAt }
}

export function serializeLockRecord(record: LockRecord): string {
	return JSON.stringify({
		version: 1,
		salt: record.salt.toString("base64"),
		hash: record.hash.toString("base64"),
		N: record.N,
		r: record.r,
		p: record.p,
		failures: record.failures,
		retryAt: record.retryAt
	})
}

export interface AppLock {
	status(): DesktopLockStatus
	// Reads the file again when it could not be read before (a keychain locked at login may be open now).
	reload(): Promise<void>
	unlock(pin: string): Promise<DesktopLockAttempt>
	set(pin: string, currentPin: string | null): Promise<DesktopLockAttempt>
	clear(currentPin: string): Promise<DesktopLockAttempt>
	// Whether it locked (false without a PIN or when already locked).
	lock(): boolean
	// Forgets the PIN and its backoff; the caller has already removed the session it guarded.
	reset(): Promise<void>
	// Removes the PIN file only when `cipher` cannot decrypt it (its key is gone with the session's), like reset.
	discardUndecryptable(cipher: VaultCipher): Promise<boolean>
}

// The record is encrypted with the session vault's cipher (safeStorage). Where the vault keeps the session in memory
// only (no OS encryption, Linux basic_text), the record is stored as plain JSON: it holds only a salted scrypt hash,
// and losing the lock on every launch would be worse. A cipher that comes or goes between runs makes the file
// unreadable, never silently ignored.
//
// Read once and kept in memory; every change is written before it takes effect. A file that exists but cannot be read
// or used fails closed: the app stays locked, and only a reset (signing out) opens it; an unreadable one is read again
// on `reload`. Operations run one at a time, so two attempts can never both pass the backoff check.
export async function loadAppLock(
	file: AtomicFile,
	cipher: () => Promise<VaultCipher | null>,
	warn: (message: string) => void,
	now: () => number = Date.now
): Promise<AppLock> {
	let record: LockRecord | null = null
	// "unreadable" may clear up on a later read; "invalid" never does.
	let fault: "unreadable" | "invalid" | null = null
	const serial = serialQueue()

	async function read(): Promise<void> {
		let data: Buffer | null

		try {
			data = await file.read()
		} catch (error) {
			warn(`app lock: the PIN file is unreadable: ${errorCode(error)}`)
			fault = "unreadable"

			return
		}

		if (data === null) {
			record = null
			fault = null

			return
		}

		let text: string
		let reEncrypt = false

		try {
			const active = await cipher()

			if (active === null) {
				text = data.toString("utf8")
			} else {
				const decrypted = await active.decrypt(data)

				text = decrypted.result
				reEncrypt = decrypted.shouldReEncrypt
			}
		} catch (error) {
			warn(`app lock: the PIN file could not be decrypted: ${errorCode(error)}`)
			fault = "unreadable"

			return
		}

		record = parseLockRecord(text)
		fault = record === null ? "invalid" : null

		if (record === null) {
			warn("app lock: the PIN file holds no valid record")
		} else if (reEncrypt) {
			await store(record).catch((error: unknown) => {
				warn(`app lock: re-encryption failed: ${errorCode(error)}`)
			})
		}
	}

	async function store(next: LockRecord): Promise<void> {
		const active = await cipher()
		const json = serializeLockRecord(next)

		await file.write(active === null ? Buffer.from(json) : await active.encrypt(json))
		record = next
	}

	await read()

	let locked = record !== null || fault !== null

	// Each attempt is counted as failed before the PIN is checked, so ending the app mid-check never saves an attempt.
	async function attempt(pin: string): Promise<DesktopLockAttempt> {
		if (record === null) {
			return { ok: false, retryAt: null }
		}

		const at = now()
		const current = normalizeAttempts(record, at)
		const blocked = retryAtOf(current, at)

		if (blocked !== null) {
			return { ok: false, retryAt: blocked }
		}

		const charged = { ...current, ...failedAttempt(current, at) }

		await store(charged)

		if (!(await verifyPin(pin, charged))) {
			warn(`app lock: wrong PIN (${String(charged.failures)} in a row)`)

			return { ok: false, retryAt: retryAtOf(charged, now()) }
		}

		await store({ ...charged, failures: 0, retryAt: 0 })

		return { ok: true }
	}

	function refuseWhileLocked(): void {
		if (locked) {
			throw new Error("locked")
		}
	}

	return {
		status: () => ({
			enabled: record !== null || fault !== null,
			locked,
			unreadable: fault !== null,
			retryAt: record === null ? null : retryAtOf(normalizeAttempts(record, now()), now())
		}),
		reload: () =>
			serial(async () => {
				if (fault === "unreadable") {
					await read()
				}
			}),
		unlock: pin =>
			serial(async () => {
				if (record === null && fault === null) {
					locked = false

					return { ok: true }
				}

				const result = await attempt(pin)

				if (result.ok) {
					locked = false
				}

				return result
			}),
		set: (pin, currentPin) =>
			serial(async () => {
				refuseWhileLocked()

				if (record !== null) {
					const result = await attempt(currentPin ?? "")

					if (!result.ok) {
						return result
					}
				}

				await store({ ...(await hashPin(pin)), failures: 0, retryAt: 0 })

				return { ok: true }
			}),
		clear: currentPin =>
			serial(async () => {
				refuseWhileLocked()

				const result = await attempt(currentPin)

				if (result.ok) {
					await file.remove()
					record = null
				}

				return result
			}),
		lock: () => {
			if ((record === null && fault === null) || locked) {
				return false
			}

			locked = true

			return true
		},
		reset: () =>
			serial(async () => {
				await file.remove()
				record = null
				fault = null
				locked = false
			}),
		discardUndecryptable: active =>
			serial(async () => {
				if (!(await removeIfUndecryptable(file, active))) {
					return false
				}

				record = null
				fault = null
				locked = false

				return true
			})
	}
}
