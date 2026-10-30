import { describe, expect, it, vi } from "vitest"
import { CHANNELS } from "../shared/channels.ts"
import { loadAppLock } from "../main/appLock.ts"
import type { IpcEvent, IpcMain } from "../main/pages.ts"
import { registerSessionRecoveryIpc, sessionDiscarder, type VaultDependent } from "../main/sessionRecovery.ts"
import { createSessionVault, removeIfUndecryptable, type VaultCipher } from "../main/sessionVault.ts"
import { fakeCipher, memoryFile } from "./fileFakes.ts"

const APP = "filen://app/"

const BLOB = JSON.stringify({
	email: "user@example.com",
	userId: "$bigint:123456789012345678n",
	rootUuid: "root-uuid",
	authInfo: "auth-info",
	privateKey: "private-key",
	apiKey: "api-key",
	authVersion: 2
})

type Dependent = "stash" | "first" | "second"

// The vault, the PIN and two mount credential files, all written with `cipher`; `stale` were written with a key that
// is gone.
async function setup(options: { sessionLost: boolean; stale: ("lock" | Dependent)[] }) {
	const cipher = fakeCipher()
	const encrypted = async (name: Dependent) => (options.stale.includes(name) ? Buffer.from("old-key") : cipher.encrypt(name))
	const sessionFile = memoryFile(options.sessionLost ? Buffer.from("old-key") : await cipher.encrypt(BLOB))
	const lockFile = memoryFile()
	const lockWriter = await loadAppLock(lockFile, () => Promise.resolve(cipher), vi.fn())

	await lockWriter.set("1234", null)

	if (options.stale.includes("lock")) {
		lockFile.data = Buffer.from("old-key")
	}

	const lock = await loadAppLock(lockFile, () => Promise.resolve(cipher), vi.fn())
	const stash = memoryFile(await encrypted("stash"))
	const credentials = { first: memoryFile(await encrypted("first")), second: memoryFile(await encrypted("second")) }
	const vault = createSessionVault(() => Promise.resolve(cipher), sessionFile, vi.fn())
	const info = vi.fn<(message: string) => void>()
	const warn = vi.fn<(message: string) => void>()
	const dependents: VaultDependent[] = [
		{ label: "app lock", discard: active => lock.discardUndecryptable(active) },
		{ label: "migration stash", discard: active => removeIfUndecryptable(stash, active) },
		...Object.values(credentials).map(file => ({
			label: "mount credentials",
			discard: (active: VaultCipher) => removeIfUndecryptable(file, active)
		}))
	]
	const discard = sessionDiscarder({
		vault,
		cipher: () => Promise.resolve(cipher),
		dependents: () => Promise.resolve(dependents),
		info,
		warn
	})

	return { cipher, sessionFile, lockFile, lock, stash, credentials, vault, discard, info, warn }
}

describe("sessionDiscarder", () => {
	it("does nothing when the session decrypts now", async () => {
		const context = await setup({ sessionLost: false, stale: ["lock", "stash", "first"] })

		await expect(context.discard()).resolves.toEqual({ status: "present", blob: BLOB })
		expect(context.sessionFile.data).not.toBeNull()
		expect(context.lockFile.data).not.toBeNull()
		expect(context.stash.data).not.toBeNull()
		expect(context.credentials.first.data).not.toBeNull()
	})

	it("removes the session and only the dependents that cannot be decrypted either", async () => {
		const context = await setup({ sessionLost: true, stale: ["lock", "first"] })

		expect(context.lock.status()).toMatchObject({ locked: true, unreadable: true })
		await expect(context.vault.get()).resolves.toEqual({ status: "unreadable" })
		await expect(context.discard()).resolves.toEqual({ status: "absent" })

		expect(context.sessionFile.data).toBeNull()
		expect(context.lockFile.data).toBeNull()
		expect(context.lock.status()).toEqual({ enabled: false, locked: false, unreadable: false, retryAt: null })
		expect(context.stash.data).not.toBeNull()
		expect(context.credentials.first.data).toBeNull()
		expect(context.credentials.second.data).not.toBeNull()
		expect(context.info.mock.calls.flat()).toEqual([
			"session recovery: removed the undecryptable app lock",
			"session recovery: removed the undecryptable mount credentials"
		])
	})

	it("keeps the PIN and every dependent its key still decrypts", async () => {
		const context = await setup({ sessionLost: true, stale: [] })

		await expect(context.discard()).resolves.toEqual({ status: "absent" })
		expect(context.sessionFile.data).toBeNull()
		expect(context.lock.status()).toMatchObject({ enabled: true, locked: true, unreadable: false })
		expect(context.stash.data).not.toBeNull()
		expect(context.credentials.first.data).not.toBeNull()
	})

	it("logs a dependent it cannot check by code and still goes on", async () => {
		const context = await setup({ sessionLost: true, stale: ["first", "second"] })

		context.credentials.first.read = () => Promise.reject(Object.assign(new Error("/secret/path"), { code: "EACCES" }))

		await expect(context.discard()).resolves.toEqual({ status: "absent" })
		expect(context.warn.mock.calls.flat()).toEqual(["session recovery: mount credentials not checked: EACCES"])
		expect(context.credentials.second.data).toBeNull()
	})

	it("leaves the session and every dependent when the vault file cannot be read", async () => {
		const context = await setup({ sessionLost: true, stale: ["stash"] })

		context.sessionFile.read = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))

		await expect(context.discard()).resolves.toEqual({ status: "unreadable" })
		expect(context.sessionFile.data).not.toBeNull()
		expect(context.stash.data).not.toBeNull()
	})

	it("checks nothing without a cipher", async () => {
		const dependents = vi.fn(() => Promise.resolve([]))
		const discard = sessionDiscarder({
			vault: createSessionVault(() => Promise.resolve(null), memoryFile(Buffer.from("old-key")), vi.fn()),
			cipher: () => Promise.resolve(null),
			dependents,
			info: vi.fn(),
			warn: vi.fn()
		})

		await expect(discard()).resolves.toEqual({ status: "absent" })
		expect(dependents).not.toHaveBeenCalled()
	})
})

describe("registerSessionRecoveryIpc", () => {
	function register() {
		const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
		const ipc: IpcMain = {
			handle: (channel, listener) => {
				handlers.set(channel, listener)
			},
			on: vi.fn()
		}
		const discard = vi.fn(() => Promise.resolve({ status: "absent" as const }))

		registerSessionRecoveryIpc(ipc, discard, url => url?.startsWith(APP) === true)

		const handler = handlers.get(CHANNELS.sessionDiscardUnreadable)

		if (handler === undefined) {
			throw new Error("not registered")
		}

		const invoke = (url: string | null, ...args: unknown[]) =>
			Promise.resolve().then(() =>
				handler({ senderFrame: url === null ? null : { url }, sender: { id: 1, send: vi.fn(), isDestroyed: () => false } }, ...args)
			)

		return { discard, invoke }
	}

	it("answers the app's own document without arguments", async () => {
		const { discard, invoke } = register()

		await expect(invoke(APP)).resolves.toEqual({ status: "absent" })
		expect(discard).toHaveBeenCalledTimes(1)
	})

	it("refuses another sender and any argument", async () => {
		const { discard, invoke } = register()

		await expect(invoke("https://evil.example/")).rejects.toThrow("untrusted sender")
		await expect(invoke(null)).rejects.toThrow("untrusted sender")
		await expect(invoke(APP, {})).rejects.toThrow("invalid session payload")
		await expect(invoke(APP, undefined)).rejects.toThrow("invalid session payload")
		expect(discard).not.toHaveBeenCalled()
	})
})
