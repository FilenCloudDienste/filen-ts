import type { Page } from "playwright-core"
import { describe, expect, it, vi } from "vitest"
import {
	backdateImport,
	cipherSeen,
	type CipherSeen,
	fallbackKeyEncrypted,
	heldProblems,
	keychainLines,
	keyringEncrypted,
	keyringSeed,
	keyringWrites,
	readLegacyOrigin,
	seedRedacted,
	seedSecrets
} from "../../scripts/ci/e2e/keyringData.ts"
import { endLeftovers } from "../../scripts/ci/e2e/chains/common.ts"
import { dbusSessionConfig, keyringDaemonArgs } from "../../scripts/ci/e2e/linux.ts"
import { loadAppLock } from "../main/appLock.ts"
import { LEGACY_KEYS, legacyPin, legacyPrefs, legacySession, legacyStash, WIPE_SCRIPT } from "../main/legacyData.ts"
import { createMigration, createStashStore, MAX_FAILED_STARTS, parseMarker, waitExpired, WIPE_AFTER_MS } from "../main/migration.ts"
import { createSessionVault, isSessionBlob, lazyCipher, type VaultCipher } from "../main/sessionVault.ts"
import type { Target } from "../../scripts/ci/targets.ts"
import { linuxCipher, memoryFile } from "./fileFakes.ts"

// Chain K's synthetic profile and the expectations it checks (scripts/ci/e2e/chains/keyring.ts), against the real
// migration, vault, stash and app lock of src/main with in-memory files: what each kind of keychain failure leaves is
// what the chain asserts, launch after launch.

const anonymousSdk = {
	email: "",
	password: "",
	masterKeys: [],
	connectToSocket: true,
	metadataCache: true,
	twoFactorCode: "",
	publicKey: "",
	privateKey: "",
	apiKey: "anonymous",
	authVersion: 2,
	baseFolderUUID: "",
	userId: 1,
	tmpPath: "/tmp"
}
const anonymous = {
	sdkConfig: anonymousSdk,
	desktopConfig: {
		sdkConfig: anonymousSdk,
		webdavConfig: { enabled: false, username: "admin", password: "admin", hostname: "127.0.0.1", port: 1900 },
		s3Config: { enabled: false },
		networkDriveConfig: { enabled: false, mountPoint: "/tmp/filen" },
		syncConfig: { enabled: true, syncPairs: [], dbPath: "" }
	}
}

const seed = keyringSeed()
const writes = keyringWrites(seed, anonymous)

// The keychain each launch meets, as safeStorage reports it through src/main/index.ts sessionCipher: none (null), a
// probe that rejects, encryption that rejects, or Chromium's fallback key ("v10"); then the keyring's key ("v11").
type Keychain = Exclude<CipherSeen, "encrypted"> | "working"

function cipherOf(keychain: Keychain): () => Promise<VaultCipher | null> {
	switch (keychain) {
		case "memory":
			return () => Promise.resolve(null)
		case "probe-rejected":
			return () => Promise.reject(new Error("the keyring is locked"))
		case "encrypt-rejected":
			return () =>
				Promise.resolve({
					encrypt: () => Promise.reject(new Error("the keyring is locked")),
					decrypt: () => Promise.reject(new Error("the keyring is locked"))
				})
		case "fallback-key":
			return () => Promise.resolve(linuxCipher("fallback"))
		case "working":
			return () => Promise.resolve(linuxCipher("keyring"))
	}
}

function disk() {
	return { marker: memoryFile(), vault: memoryFile(), lock: memoryFile(), stash: memoryFile() }
}

// One launch of N as src/main/index.ts wires it: one shared cipher, the vault, the app lock, the stash, the migration
// before the window (locking when it imported a PIN), and the wipe it starts in the background.
async function launch(files: ReturnType<typeof disk>, keychain: Keychain, now = Date.now()) {
	const lines: string[] = []
	const log = (message: string) => {
		lines.push(message)
	}
	const cipher = lazyCipher(cipherOf(keychain))
	const vault = createSessionVault(cipher, files.vault, log)
	const lock = await loadAppLock(files.lock, cipher, log)
	const stash = createStashStore(files.stash, cipher, log)
	const prefs = vi.fn((_patch: unknown) => Promise.resolve())
	const wipeLegacy = vi.fn(() => Promise.resolve())
	const migration = createMigration({
		marker: files.marker,
		legacyProfile: () => Promise.resolve(true),
		readLegacy: () => Promise.resolve({ count: Object.keys(writes).length + 3, values: writes }),
		readOptions: () => Promise.resolve(null),
		wipeLegacy,
		removeRcloneConfig: () => Promise.resolve(),
		removeLegacyLogs: () => Promise.resolve(),
		earlyPurge: () => ({ result: "not-due" }),
		vault,
		lock: { enabled: () => lock.status().enabled, set: async pin => (await lock.set(pin, null)).ok },
		prefs: { set: prefs },
		launchesAtLogin: () => false,
		applyLaunchAtLogin: () => Promise.resolve(),
		writeStash: text => stash.write(text),
		now: () => now,
		info: log,
		warn: log
	})

	if ((await migration.start()).pinImported) {
		lock.lock()
	}

	// The wipe runs after start, in the background.
	await new Promise(resolve => setTimeout(resolve, 0))

	// index.ts logs the probe itself, and its memory mode when the cipher resolves null; the rest comes from src/main as it
	// is.
	const text = [...(keychain === "fallback-key" ? ["secure storage: available, backend gnome_libsecret, probe v10"] : []), ...lines].join(
		"\n"
	)

	return {
		log: text,
		seen: keychain === "memory" ? ("memory" as const) : cipherSeen(text),
		marker: parseMarker(files.marker.data?.toString("utf8") ?? null),
		lock,
		vault,
		prefs,
		wipeLegacy
	}
}

function fakeStorage(entries: Record<string, string>) {
	const map = new Map(Object.entries(entries))

	return {
		map,
		get length() {
			return map.size
		},
		key: (index: number) => [...map.keys()][index] ?? null,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value)
		},
		removeItem: (key: string) => {
			map.delete(key)
		}
	}
}

function fakeIndexedDb() {
	const names = new Set(["Filen"])

	return {
		databases: () => Promise.resolve([...names].map(name => ({ name }))),
		deleteDatabase: (name: string) => {
			const request: { onsuccess?: () => void } = {}

			names.delete(name)
			queueMicrotask(() => request.onsuccess?.())

			return request
		}
	}
}

// A page whose evaluate runs the function here, on the globals the test stubs.
const page = { evaluate: (run: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(run(arg)) } as unknown as Page

describe("chain K's synthetic 3.x profile", () => {
	it("is a signed-in profile N imports: the session, the PIN, both prefs and the other user's settings", () => {
		const session = legacySession(writes)

		expect(session.ok && session.userId).toBe(Number(seed.client.userId))
		expect(session.ok && isSessionBlob(session.blob)).toBe(true)
		expect(legacyPin(writes)).toBe(seed.pin)
		expect(legacyPrefs(writes, null)).toEqual({ minimizeToTray: true, startMinimized: true })

		const stash = legacyStash(writes, Number(seed.client.userId))
		const other = String(seed.otherUserId)

		expect(Object.keys(stash?.users.sync ?? {})).toEqual([other])
		expect(Object.keys(stash?.users.networkDrive ?? {})).toEqual([other])
		expect(Object.keys(stash?.users.webdav ?? {})).toEqual([other])
		expect(seed.otherUserId).not.toBe(Number(seed.client.userId))
	})

	it("holds every secret the scans look for, and the redactor masks each of them", () => {
		const values = Object.values(writes).join("\n")

		for (const secret of seedSecrets(seed)) {
			expect(values).toContain(secret)
			expect(seedRedacted(seed)).toContain(secret)
		}

		expect(seedRedacted(seed)).toEqual(expect.arrayContaining([seed.pin, seed.client.email, String(seed.client.userId)]))
		expect(keyringSeed().client.apiKey).not.toBe(seed.client.apiKey)
	})

	it("reads the old origin before and after the wipe: the account, PIN and WebDAV password go, the rest stays", async () => {
		const storage = fakeStorage({ ...writes, theme: '"dark"' })

		vi.stubGlobal("localStorage", storage)
		vi.stubGlobal("indexedDB", fakeIndexedDb())

		const before = await readLegacyOrigin(page, seedSecrets(seed))

		expect(before.present).toEqual(expect.arrayContaining([LEGACY_KEYS.sdkConfig, LEGACY_KEYS.lockPin]))
		expect(before).toMatchObject({ desktopSdkConfig: true, webdavPasswords: 1, indexedDb: true })
		expect(before.holding).toBeGreaterThan(0)

		await expect(new Function(`return ${WIPE_SCRIPT}`)() as Promise<unknown>).resolves.toBe(true)

		const after = await readLegacyOrigin(page, seedSecrets(seed))

		expect(after.present).not.toContain(LEGACY_KEYS.sdkConfig)
		expect(after.present).not.toContain(LEGACY_KEYS.lockPin)
		expect(after.present).toEqual(expect.arrayContaining([LEGACY_KEYS.authed, LEGACY_KEYS.desktopConfig, LEGACY_KEYS.webdav]))
		expect(after).toMatchObject({ holding: 0, desktopSdkConfig: false, webdavPasswords: 0, indexedDb: false })
	})
})

describe("chain K's expectations against B1", () => {
	for (const keychain of ["memory", "probe-rejected", "encrypt-rejected"] as const) {
		it(`holds the import uncounted while the keyring is ${keychain}, then completes it and keeps the lock usable`, async () => {
			const files = disk()

			// More locked launches than the old code gave up after.
			for (let index = 0; index <= MAX_FAILED_STARTS; index++) {
				const locked = await launch(files, keychain)

				expect(locked.seen).toBe(keychain)
				expect(heldProblems(locked.marker, locked.seen)).toEqual([])
				// Only an import in memory takes the PIN (as a plain record), and N then starts locked.
				expect(locked.lock.status()).toMatchObject({
					enabled: keychain === "memory",
					locked: keychain === "memory",
					unreadable: false
				})
			}

			expect(files.vault.data).toBeNull()
			expect(files.stash.data).toBeNull()

			const unlocked = await launch(files, "working")

			expect(unlocked.seen).toBe("encrypted")
			expect(unlocked.marker).toMatchObject({
				stage: "imported",
				userId: Number(seed.client.userId),
				volatileStash: false,
				deferred: false
			})
			expect(keyringEncrypted(files.stash.data)).toBe(true)
			expect(keyringEncrypted(files.lock.data)).toBe(true)
			// The memory path imported the session for that run only; the stash import afterwards leaves it.
			expect((await unlocked.vault.get()).status).toBe(keychain === "memory" ? "absent" : "present")
			expect(unlocked.lock.status()).toMatchObject({ enabled: true, locked: true, unreadable: false })
			await expect(unlocked.lock.unlock(seed.pin)).resolves.toEqual({ ok: true })
		})
	}

	it("imports on the fallback key, stored with v10, and the keyring's key re-encrypts the PIN and the session it reads", async () => {
		const files = disk()

		for (let index = 0; index <= MAX_FAILED_STARTS; index++) {
			const fallback = await launch(files, "fallback-key")

			expect(fallback.seen).toBe("fallback-key")
			expect(heldProblems(fallback.marker, fallback.seen)).toEqual([])
			expect(fallback.marker).toMatchObject({ stage: "imported", userId: Number(seed.client.userId), deferred: false })
			expect(fallback.lock.status()).toMatchObject({ enabled: true, locked: true, unreadable: false })
		}

		expect([files.vault.data, files.lock.data, files.stash.data].every(data => fallbackKeyEncrypted(data))).toBe(true)

		const unlocked = await launch(files, "working")

		expect(unlocked.seen).toBe("encrypted")
		expect(unlocked.marker).toMatchObject({ stage: "imported", volatileStash: false, deferred: false })
		expect(keyringEncrypted(files.lock.data)).toBe(true)
		await expect(unlocked.vault.get()).resolves.toMatchObject({ status: "present" })
		expect(keyringEncrypted(files.vault.data)).toBe(true)
		// Read only by a sign-in, the stash keeps the fallback key until then.
		expect(fallbackKeyEncrypted(files.stash.data)).toBe(true)
		await expect(unlocked.lock.unlock(seed.pin)).resolves.toEqual({ ok: true })
	})

	it("wipes once importedAt is backdated past the wait", async () => {
		const files = disk()

		await launch(files, "working")

		const text = files.marker.data?.toString("utf8") ?? ""
		const backdated = parseMarker(backdateImport(text, WIPE_AFTER_MS + 24 * 60 * 60 * 1000))

		expect(backdated).not.toBeNull()
		expect(backdated !== null && waitExpired(backdated, Date.now())).toBe(true)
		expect(() => backdateImport(JSON.stringify({ version: 1, stage: "started", importedAt: null }), 1)).toThrow(/no importedAt/)

		files.marker.data = Buffer.from(backdateImport(text, WIPE_AFTER_MS + 24 * 60 * 60 * 1000))

		const later = await launch(files, "working")

		expect(later.wipeLegacy).toHaveBeenCalledOnce()
		expect(later.marker).toMatchObject({ stage: "verified", wiped: true, logsDeleted: true })
	})

	it("names what is wrong with a marker that did not hold the import", () => {
		const held = { stage: "started", failedStarts: 0, prefsImported: true, wiped: false, deferred: true, volatileStash: false }

		expect(heldProblems(held, "probe-rejected")).toEqual([])
		expect(heldProblems(null, "memory")).toEqual(["no migration.json"])
		expect(heldProblems({ ...held, failedStarts: 1 }, "probe-rejected")).toEqual(["failedStarts 1 (counted as a failure)"])
		expect(heldProblems({ ...held, stage: "abandoned" }, "encrypt-rejected")).toEqual(["stage abandoned"])
		expect(heldProblems({ ...held, prefsImported: false, wiped: true }, "probe-rejected")).toEqual(["prefs not imported", "wiped"])
		expect(heldProblems(held, "encrypted")).toEqual(["safeStorage encrypted: nothing held the import"])
		expect(heldProblems(held, "fallback-key")).toEqual(["stage started", "on the fallback key: volatileStash false, deferred true"])
		expect(heldProblems({ ...held, stage: "imported", deferred: false }, "fallback-key")).toEqual([])
		expect(heldProblems(held, "memory")[0]).toMatch(/^in memory: volatileStash false/)
		expect(heldProblems({ ...held, deferred: false }, "encrypt-rejected")[0]).toMatch(/^refused: deferred false/)
	})

	it("tells the cipher paths apart from what main logs, and keeps only the keychain lines", () => {
		expect(cipherSeen("session vault: no secure storage (basic_text); keeping the session in memory only")).toBe("memory")
		expect(cipherSeen("session vault encryption unavailable: Error")).toBe("probe-rejected")
		expect(cipherSeen("migration: deferred, tried again next launch: stash: safeStorage")).toBe("encrypt-rejected")
		expect(cipherSeen("migration: deferred, tried again next launch: vault status: unreadable")).toBe("encrypted")
		expect(cipherSeen(" INFO secure storage: available, backend gnome_libsecret, probe v10\n")).toBe("fallback-key")
		expect(cipherSeen(" INFO secure storage: available, backend gnome_libsecret, probe v11\n")).toBe("encrypted")
		expect(
			keychainLines(
				" INFO Filen 4.0.0 starting\n INFO secure storage: available, backend gnome_libsecret, probe v10\n WARN migration: deferred (x)\n INFO app lock: y\n"
			)
		).toEqual([
			"INFO secure storage: available, backend gnome_libsecret, probe v10",
			"WARN migration: deferred (x)",
			"INFO app lock: y"
		])
	})
})

describe("chain K's Secret Service and files", () => {
	it("runs a bus that activates nothing and listens on its own socket only", () => {
		const config = dbusSessionConfig("/tmp/k <&> bus/bus")

		expect(config).toContain("<listen>unix:path=/tmp/k &lt;&amp;&gt; bus/bus</listen>")
		expect(config).not.toMatch(/servicedir|standard_session_servicedirs/)
		expect(config).toContain("<type>session</type>")
	})

	it("starts gnome-keyring with secrets only, unlocking the login keyring only when asked", () => {
		expect(keyringDaemonArgs(true)).toEqual(["--replace", "--foreground", "--components=secrets", "--unlock"])
		expect(keyringDaemonArgs(false)).toEqual(["--replace", "--foreground", "--components=secrets"])
	})

	it("tells the keyring's key (v11) from the hardcoded one and plain text", () => {
		expect(keyringEncrypted(Buffer.from("v11abc"))).toBe(true)
		expect(keyringEncrypted(Buffer.from("v10abc"))).toBe(false)
		expect(keyringEncrypted(Buffer.from('{"version":1}'))).toBe(false)
		expect(keyringEncrypted(null)).toBe(false)
		expect(fallbackKeyEncrypted(Buffer.from("v10abc"))).toBe(true)
		expect(fallbackKeyEncrypted(Buffer.from("v11abc"))).toBe(false)
		expect(fallbackKeyEncrypted(null)).toBe(false)
	})
})

describe("chain K's quit of 3.0.53", () => {
	const target = { platform: "linux" } as unknown as Target

	it("waits for nothing when the old app ended whole", async () => {
		const settle = vi.fn(() => Promise.resolve())
		const forceKill = vi.fn(() => Promise.resolve())

		await expect(endLeftovers({ appProcesses: () => Promise.resolve([]), forceKill }, target, settle, 50, 1)).resolves.toEqual([])
		expect(settle).not.toHaveBeenCalled()
		expect(forceKill).not.toHaveBeenCalled()
	})

	it("hard-kills what lingers past the main process once its storage settled, and names it", async () => {
		const order: string[] = []
		let left = ["4242 /opt/Filen/chrome_crashpad_handler", "4250 /opt/Filen/Filen"]
		const os = {
			appProcesses: () => Promise.resolve(left),
			forceKill: (pids: readonly number[]) => {
				order.push(`kill ${pids.join(",")}`)
				left = []

				return Promise.resolve()
			}
		}
		const settle = () => {
			order.push("settled")

			return Promise.resolve()
		}

		await expect(endLeftovers(os, target, settle, 20, 1)).resolves.toEqual([
			"4242 /opt/Filen/chrome_crashpad_handler",
			"4250 /opt/Filen/Filen"
		])
		expect(order).toEqual(["settled", "kill 4242,4250"])
	})

	it("fails, naming them, when the hard kill leaves processes behind", async () => {
		const os = { appProcesses: () => Promise.resolve(["4242 /opt/Filen/Filen"]), forceKill: () => Promise.resolve() }

		await expect(endLeftovers(os, target, () => Promise.resolve(), 10, 1)).rejects.toThrow(
			/the old app's processes to end after the hard kill: 4242 \/opt\/Filen\/Filen/
		)
	})
})
