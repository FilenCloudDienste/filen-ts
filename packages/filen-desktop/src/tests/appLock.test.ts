import { describe, expect, it, vi } from "vitest"
import type { AtomicFile } from "../main/atomicFile.ts"
import {
	BACKOFF_BASE_MS,
	BACKOFF_MAX_MS,
	backoffDelay,
	failedAttempt,
	FREE_ATTEMPTS,
	hashPin,
	loadAppLock,
	normalizeAttempts,
	parseLockRecord,
	PIN_HASH_PARAMS,
	retryAtOf,
	serializeLockRecord,
	verifyPin
} from "../main/appLock.ts"
import type { VaultCipher } from "../main/sessionVault.ts"

function memoryFile(initial: Buffer | null = null): AtomicFile & { data: Buffer | null } {
	const file = {
		data: initial,
		read: () => Promise.resolve(file.data),
		write: (data: Buffer) => {
			file.data = data

			return Promise.resolve()
		},
		remove: () => {
			file.data = null

			return Promise.resolve()
		}
	}

	return file
}

function fakeCipher(): VaultCipher & { failDecrypt: boolean } {
	const cipher = {
		failDecrypt: false,
		encrypt: (plain: string) => Promise.resolve(Buffer.from(`enc:${plain}`)),
		decrypt: (encrypted: Buffer) => {
			const text = encrypted.toString("utf8")

			if (cipher.failDecrypt || !text.startsWith("enc:")) {
				return Promise.reject(new Error("decrypt failed"))
			}

			return Promise.resolve({ result: text.slice(4), shouldReEncrypt: false })
		}
	}

	return cipher
}

describe("backoff", () => {
	it("lets the first attempts through, then doubles the wait up to the cap", () => {
		expect(backoffDelay(FREE_ATTEMPTS - 1)).toBe(0)
		expect(backoffDelay(FREE_ATTEMPTS)).toBe(BACKOFF_BASE_MS)
		expect(backoffDelay(FREE_ATTEMPTS + 1)).toBe(BACKOFF_BASE_MS * 2)
		expect(backoffDelay(FREE_ATTEMPTS + 30)).toBe(BACKOFF_MAX_MS)
	})

	it("records a failure and when the next attempt is accepted", () => {
		expect(failedAttempt({ failures: 0, retryAt: 0 }, 1000)).toEqual({ failures: 1, retryAt: 0 })
		expect(failedAttempt({ failures: FREE_ATTEMPTS - 1, retryAt: 0 }, 1000)).toEqual({
			failures: FREE_ATTEMPTS,
			retryAt: 1000 + BACKOFF_BASE_MS
		})
	})

	it("cuts a wait the clock going back made longer than earned, once", () => {
		const state = { failures: FREE_ATTEMPTS, retryAt: 10_000_000 }
		const normalized = normalizeAttempts(state, 0)

		expect(normalized.retryAt).toBe(BACKOFF_BASE_MS)
		expect(normalizeAttempts(normalized, 1000)).toBe(normalized)
	})

	it("reports a wait only while it lasts", () => {
		expect(retryAtOf({ failures: 9, retryAt: 2000 }, 1000)).toBe(2000)
		expect(retryAtOf({ failures: 9, retryAt: 2000 }, 2000)).toBeNull()
	})
})

describe("PIN hash", () => {
	it("verifies the PIN it was made from, with a random salt and today's params", async () => {
		const first = await hashPin("1234")
		const second = await hashPin("1234")

		expect(first).toMatchObject(PIN_HASH_PARAMS)
		expect(first.salt.equals(second.salt)).toBe(false)
		expect(first.hash.equals(second.hash)).toBe(false)
		await expect(verifyPin("1234", first)).resolves.toBe(true)
		await expect(verifyPin("1235", first)).resolves.toBe(false)
	})

	it("round-trips a record and rejects tampered or weakened ones", async () => {
		const record = { ...(await hashPin("1234")), failures: 2, retryAt: 0 }
		const json = serializeLockRecord(record)

		expect(parseLockRecord(json)).toEqual(record)
		expect(json).not.toContain("1234")

		const stored = JSON.parse(json) as Record<string, unknown>

		expect(parseLockRecord("{")).toBeNull()
		expect(parseLockRecord(JSON.stringify({ ...stored, N: 1024 }))).toBeNull()
		expect(parseLockRecord(JSON.stringify({ ...stored, N: 2 ** 20 }))).toBeNull()
		expect(parseLockRecord(JSON.stringify({ ...stored, N: 40000 }))).toBeNull()
		expect(parseLockRecord(JSON.stringify({ ...stored, hash: "AAAA" }))).toBeNull()
		expect(parseLockRecord(JSON.stringify({ ...stored, failures: -1 }))).toBeNull()
	})
})

describe("loadAppLock", () => {
	const warn = vi.fn()

	async function lockWithPin(pin: string, file = memoryFile(), cipher: VaultCipher | null = fakeCipher(), now = () => 0) {
		const lock = await loadAppLock(file, () => Promise.resolve(cipher), warn, now)

		await expect(lock.set(pin, null)).resolves.toEqual({ ok: true })

		return { lock, file }
	}

	it("starts unlocked without a PIN and refuses to lock", async () => {
		const lock = await loadAppLock(memoryFile(), () => Promise.resolve(fakeCipher()), warn)

		expect(lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null })
		expect(lock.lock()).toBe(false)
	})

	it("stores the record encrypted, starts locked with it and unlocks with the right PIN", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("123456", memoryFile(), cipher)

		expect(file.data?.toString("utf8").startsWith("enc:")).toBe(true)

		const lock = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		expect(lock.status()).toMatchObject({ enabled: true, locked: true })
		await expect(lock.unlock("654321")).resolves.toEqual({ ok: false, retryAt: null })
		expect(lock.status().locked).toBe(true)
		await expect(lock.unlock("123456")).resolves.toEqual({ ok: true })
		expect(lock.status().locked).toBe(false)
		expect(lock.lock()).toBe(true)
		expect(lock.status().locked).toBe(true)
	})

	it("keeps a plain record where the vault has no cipher", async () => {
		const { file } = await lockWithPin("1234", memoryFile(), null)

		expect(parseLockRecord(file.data?.toString("utf8") ?? "")).not.toBeNull()
	})

	it("backs off after the free attempts, refuses attempts during the wait and survives a restart", async () => {
		let time = 0
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher, () => time)
		const lock = await loadAppLock(
			file,
			() => Promise.resolve(cipher),
			warn,
			() => time
		)

		for (let index = 1; index < FREE_ATTEMPTS; index++) {
			await expect(lock.unlock("0000")).resolves.toEqual({ ok: false, retryAt: null })
		}

		await expect(lock.unlock("0000")).resolves.toEqual({ ok: false, retryAt: BACKOFF_BASE_MS })

		const restarted = await loadAppLock(
			file,
			() => Promise.resolve(cipher),
			warn,
			() => time
		)

		expect(restarted.status().retryAt).toBe(BACKOFF_BASE_MS)
		// Even the right PIN is not checked during the wait.
		await expect(restarted.unlock("1234")).resolves.toEqual({ ok: false, retryAt: BACKOFF_BASE_MS })

		time = BACKOFF_BASE_MS
		await expect(restarted.unlock("1234")).resolves.toEqual({ ok: true })
		expect(restarted.status().retryAt).toBeNull()

		const after = await loadAppLock(
			file,
			() => Promise.resolve(cipher),
			warn,
			() => time
		)

		await expect(after.unlock("0000")).resolves.toEqual({ ok: false, retryAt: null })
	})

	it("counts an attempt before checking it", async () => {
		const cipher = fakeCipher()
		const { lock, file } = await lockWithPin("1234", memoryFile(), cipher)
		const writes: Buffer[] = []
		const write = file.write.bind(file)

		file.write = data => {
			writes.push(data)

			return write(data)
		}

		lock.lock()
		await lock.unlock("1234")

		expect(writes.map(data => parseLockRecord(data.toString("utf8").slice(4))?.failures)).toEqual([1, 0])
	})

	it("changes and removes the PIN only with the current one, and never while locked", async () => {
		const { lock, file } = await lockWithPin("1234")

		await expect(lock.set("5678", "0000")).resolves.toEqual({ ok: false, retryAt: null })
		await expect(lock.set("5678", "1234")).resolves.toEqual({ ok: true })
		await expect(lock.clear("1234")).resolves.toEqual({ ok: false, retryAt: null })

		lock.lock()
		await expect(lock.clear("5678")).rejects.toThrow("locked")
		await expect(lock.set("1111", "5678")).rejects.toThrow("locked")
		await lock.unlock("5678")

		await expect(lock.clear("5678")).resolves.toEqual({ ok: true })
		expect(file.data).toBeNull()
		expect(lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null })
	})

	it("fails closed on a record it cannot decrypt, and reads it again on reload", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher)

		cipher.failDecrypt = true

		const lock = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		expect(lock.status()).toEqual({ enabled: true, locked: true, unreadable: true, retryAt: null })
		await expect(lock.unlock("1234")).resolves.toEqual({ ok: false, retryAt: null })

		cipher.failDecrypt = false
		await lock.reload()
		expect(lock.status()).toMatchObject({ unreadable: false, locked: true })
		await expect(lock.unlock("1234")).resolves.toEqual({ ok: true })
	})

	it("fails closed on an invalid record or a cipher that changed, until a reset", async () => {
		const plain = await lockWithPin("1234", memoryFile(), null)
		// Written without a cipher, read with one: not silently accepted.
		const lock = await loadAppLock(plain.file, () => Promise.resolve(fakeCipher()), warn)

		expect(lock.status()).toMatchObject({ enabled: true, locked: true, unreadable: true })

		const invalid = await loadAppLock(memoryFile(Buffer.from("enc:{}")), () => Promise.resolve(fakeCipher()), warn)

		expect(invalid.status()).toMatchObject({ enabled: true, locked: true, unreadable: true })
		await invalid.reset()
		expect(invalid.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null })
	})
})
