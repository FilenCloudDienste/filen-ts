import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AtomicFile } from "../main/atomicFile.ts"
import {
	BACKOFF_BASE_MS,
	BACKOFF_MAX_MS,
	backoffDelay,
	failedAttempt,
	FREE_ATTEMPTS,
	hashPin,
	inactivityLock,
	inactivityLockDue,
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

describe("inactivityLockDue", () => {
	it("locks after the chosen time without input, by the clock", () => {
		expect(inactivityLockDue(1000, 1000 + 300_000 - 1, 300)).toBe(false)
		expect(inactivityLockDue(1000, 1000 + 300_000, 300)).toBe(true)
		// A night asleep: the timer never fired, the clock moved on.
		expect(inactivityLockDue(1000, 1000 + 8 * 60 * 60 * 1000, 300)).toBe(true)
	})

	it("never locks under Never", () => {
		expect(inactivityLockDue(0, Number.MAX_SAFE_INTEGER, 0)).toBe(false)
	})

	it("waits after a clock set back", () => {
		expect(inactivityLockDue(300_000, 0, 60)).toBe(false)
	})
})

describe("inactivityLock", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function harness(initial: { seconds: number; armed: boolean }) {
		const state = { ...initial, locks: 0, listening: [] as boolean[] }
		const controller = inactivityLock({
			lockAfterSeconds: () => state.seconds,
			armed: () => state.armed,
			lock: () => {
				state.locks++
				state.armed = false
				controller.rearm()
			},
			listen: listening => {
				state.listening.push(listening)
			}
		})

		return { state, controller }
	}

	it("locks once the time passes without input", () => {
		const { state, controller } = harness({ seconds: 60, armed: true })

		controller.rearm()
		expect(state.listening.at(-1)).toBe(true)
		vi.advanceTimersByTime(59_999)
		expect(state.locks).toBe(0)
		vi.advanceTimersByTime(1)
		expect(state.locks).toBe(1)
		// Locked: input is no longer wanted and no timer is left.
		expect(state.listening.at(-1)).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("pushes the lock back by input with a single timer", () => {
		const { state, controller } = harness({ seconds: 60, armed: true })

		controller.rearm()

		for (let i = 0; i < 100; i++) {
			vi.advanceTimersByTime(30_000)
			controller.activity()
		}

		expect(state.locks).toBe(0)
		expect(vi.getTimerCount()).toBe(1)
		vi.advanceTimersByTime(60_000)
		expect(state.locks).toBe(1)
	})

	it("neither listens nor runs a timer without a PIN, while locked or under Never", () => {
		const unarmed = harness({ seconds: 60, armed: false })

		unarmed.controller.rearm()
		expect(unarmed.state.listening).toEqual([false])
		expect(vi.getTimerCount()).toBe(0)

		const never = harness({ seconds: 0, armed: true })

		never.controller.rearm()
		never.controller.check()
		vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
		expect(never.state.listening).toEqual([false])
		expect(never.state.locks).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("starts counting when it starts listening, so an old stamp never locks at once", () => {
		const { state, controller } = harness({ seconds: 0, armed: true })

		controller.rearm()
		vi.advanceTimersByTime(60 * 60 * 1000)
		// Never → 1 minute an hour after the last stamp.
		state.seconds = 60
		controller.rearm()
		expect(state.locks).toBe(0)
		vi.advanceTimersByTime(60_000)
		expect(state.locks).toBe(1)
	})

	it("counts the remaining time on a shorter choice", () => {
		const { state, controller } = harness({ seconds: 3600, armed: true })

		controller.rearm()
		vi.advanceTimersByTime(4 * 60_000)
		state.seconds = 300
		controller.rearm()
		vi.advanceTimersByTime(60_000 - 1)
		expect(state.locks).toBe(0)
		vi.advanceTimersByTime(1)
		expect(state.locks).toBe(1)
	})

	it("locks on the way back when the clock moved on while the timer slept", () => {
		const { state, controller } = harness({ seconds: 300, armed: true })

		controller.rearm()
		// A sleep: wall clock forward, the timer not fired.
		vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
		controller.check()
		expect(state.locks).toBe(1)
	})

	it("does not lock on the way back before the time is up", () => {
		const { state, controller } = harness({ seconds: 300, armed: true })

		controller.rearm()
		vi.advanceTimersByTime(60_000)
		controller.check()
		expect(state.locks).toBe(0)
	})

	it("re-counts from now after the clock was set back", () => {
		const { state, controller } = harness({ seconds: 60, armed: true })

		controller.rearm()
		vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000)
		vi.advanceTimersByTime(60_000)
		// The first wakeup finds the stamp in the future and restarts the period from the new clock.
		expect(state.locks).toBe(0)
		vi.advanceTimersByTime(60_000)
		expect(state.locks).toBe(1)
	})
})

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

		expect(lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: false })
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
		expect(lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: false })
	})

	it("fails closed on a record it cannot decrypt, and reads it again on reload", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher)

		cipher.failDecrypt = true

		const lock = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		expect(lock.status()).toEqual({ enabled: true, locked: true, unreadable: true, retryAt: null, waitingForSecureStorage: false })
		await expect(lock.unlock("1234")).resolves.toEqual({ ok: false, retryAt: null })

		cipher.failDecrypt = false
		await lock.reload()
		expect(lock.status()).toMatchObject({ unreadable: false, locked: true })
		await expect(lock.unlock("1234")).resolves.toEqual({ ok: true })
	})

	it("reads a plain record once a keyring appeared, and encrypts it", async () => {
		const { file } = await lockWithPin("1234", memoryFile(), null)
		const lock = await loadAppLock(file, () => Promise.resolve(fakeCipher()), warn)

		expect(lock.status()).toEqual({ enabled: true, locked: true, unreadable: false, retryAt: null, waitingForSecureStorage: false })
		expect(file.data?.toString("utf8").startsWith("enc:")).toBe(true)
		await expect(lock.unlock("1234")).resolves.toEqual({ ok: true })
	})

	it("reads a plain record while the probe fails, leaving it plain", async () => {
		const { file } = await lockWithPin("1234", memoryFile(), null)
		const stored = file.data
		const lock = await loadAppLock(file, () => Promise.reject(new Error("probe")), warn)

		expect(lock.status()).toEqual({ enabled: true, locked: true, unreadable: false, retryAt: null, waitingForSecureStorage: false })
		expect(file.data).toBe(stored)
	})

	it("keeps an encrypted record unused and unchanged while the keyring is gone, and reads it once it is back", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher)
		const stored = file.data
		const memory = await loadAppLock(file, () => Promise.resolve(null), warn)

		expect(memory.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: true })
		expect(file.data).toBe(stored)

		const back = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		expect(back.status()).toMatchObject({ enabled: true, locked: true, unreadable: false })
		await expect(back.unlock("1234")).resolves.toEqual({ ok: true })
	})

	it("refuses a new PIN over an encrypted one that waits for secure storage, until a reset or a run that has it", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher)
		const stored = file.data
		const memory = await loadAppLock(file, () => Promise.resolve(null), warn)

		await expect(memory.set("5678", null)).resolves.toEqual({ ok: false, retryAt: null })
		expect(file.data).toBe(stored)
		expect(memory.status()).toMatchObject({ enabled: false, waitingForSecureStorage: true })
		expect(warn).toHaveBeenCalledWith("app lock: a new PIN is refused while the stored one waits for secure storage")

		const back = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		expect(back.status()).toMatchObject({ enabled: true, waitingForSecureStorage: false })
		await expect(back.unlock("1234")).resolves.toEqual({ ok: true })

		await memory.reset()
		expect(memory.status()).toMatchObject({ waitingForSecureStorage: false })
		await expect(memory.set("5678", null)).resolves.toEqual({ ok: true })
		expect(file.data?.toString().startsWith("{")).toBe(true)
	})

	it("refuses no PIN over a plain record or none while there is no secure storage", async () => {
		const lock = await loadAppLock(memoryFile(), () => Promise.resolve(null), warn)

		expect(lock.status()).toMatchObject({ waitingForSecureStorage: false })
		await expect(lock.set("1234", null)).resolves.toEqual({ ok: true })
	})

	it("fails closed on an invalid record, until a reset", async () => {
		const plainInvalid = await loadAppLock(memoryFile(Buffer.from("{}")), () => Promise.resolve(null), warn)

		expect(plainInvalid.status()).toMatchObject({ enabled: true, locked: true, unreadable: true })

		const invalid = await loadAppLock(memoryFile(Buffer.from("enc:{}")), () => Promise.resolve(fakeCipher()), warn)

		expect(invalid.status()).toMatchObject({ enabled: true, locked: true, unreadable: true })
		await invalid.reset()
		expect(invalid.status()).toEqual({
			enabled: false,
			locked: false,
			unreadable: false,
			retryAt: null,
			waitingForSecureStorage: false
		})
	})

	it("discards the record only when its key is gone", async () => {
		const cipher = fakeCipher()
		const { file } = await lockWithPin("1234", memoryFile(), cipher)
		const lock = await loadAppLock(file, () => Promise.resolve(cipher), warn)

		await expect(lock.discardUndecryptable(cipher)).resolves.toBe(false)
		expect(file.data).not.toBeNull()
		expect(lock.status()).toMatchObject({ enabled: true, locked: true })

		cipher.failDecrypt = true
		await expect(lock.discardUndecryptable(cipher)).resolves.toBe(true)
		expect(file.data).toBeNull()
		expect(lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null, waitingForSecureStorage: false })
	})

	it("never discards a plain record, which needs no key", async () => {
		const { file } = await lockWithPin("1234", memoryFile(), null)
		const lock = await loadAppLock(file, () => Promise.reject(new Error("probe")), warn)
		const cipher = fakeCipher()

		cipher.failDecrypt = true
		await expect(lock.discardUndecryptable(cipher)).resolves.toBe(false)
		expect(file.data).not.toBeNull()
		expect(lock.status()).toMatchObject({ enabled: true, locked: true })
	})
})
