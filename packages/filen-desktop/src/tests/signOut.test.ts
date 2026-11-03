import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { atomicFile } from "../main/atomicFile.ts"
import {
	createSignOut,
	deleteProfileStorage,
	PROFILE_ENTRIES,
	type ProfileOutcome,
	type ProfileWipeDeps,
	removeTree,
	type SignOutSteps,
	wipeProfileBeforeReady,
	type WipePart
} from "../main/signOut.ts"

const USER = "123456"
const OTHER = "777"

let userData: string

beforeEach(async () => {
	userData = await realpath(await mkdtemp(path.join(tmpdir(), "filen-sign-out-")))
})

afterEach(async () => {
	await rm(userData, { recursive: true, force: true })
})

function at(...parts: string[]): string {
	return path.join(userData, ...parts)
}

// What CI found after a sign-out, for `userId`.
async function seed(userId: string): Promise<void> {
	await mkdir(at("sync-engine", userId), { recursive: true })

	for (const name of ["baseline.db", "cache.db", "cache.db-wal", "cache.db-shm", "shell.json"]) {
		await writeFile(at("sync-engine", userId, name), "data")
	}

	for (const dir of ["cache", "state"]) {
		await mkdir(at("mounts", userId, dir), { recursive: true })
		await writeFile(at("mounts", userId, dir, "item"), "data")
	}

	await writeFile(at("mounts", userId, "credentials.bin"), "secret")
	await writeFile(at("mounts", userId, "mounts.json"), "{}")
}

function busy(): Error {
	return Object.assign(new Error("resource busy or locked"), { code: "EBUSY" })
}

function setup(options: { mountsGo?: boolean; failing?: Set<string>; profile?: ProfileOutcome } = {}) {
	const order: string[] = []
	const failing = options.failing ?? new Set<string>()
	const lockFile = at("lock.vault")
	const forgotten: [string, WipePart[]][] = []
	const steps = {
		fileProvider: vi.fn((_userId: string | null) => {
			order.push("fileProvider")

			return Promise.resolve()
		}),
		mounts: vi.fn((_userId: string) => {
			order.push("mounts")

			return Promise.resolve(options.mountsGo ?? true)
		}),
		// Exits a moment later, as a host closing its engine does.
		stopHost: vi.fn(
			() =>
				new Promise<void>(resolve => {
					setTimeout(() => {
						order.push("host exited")
						resolve()
					}, 20)
				})
		),
		forget: vi.fn((userId: string, parts: readonly WipePart[]) => {
			order.push("forget")
			forgotten.push([userId, [...parts]])
		}),
		discardStash: vi.fn(async () => {
			order.push("discardStash")

			if (failing.has(at("migration.stash"))) {
				throw busy()
			}

			await rm(at("migration.stash"), { force: true })
		}),
		resetLock: vi.fn(async () => {
			order.push("resetLock")

			if (failing.has(lockFile)) {
				throw busy()
			}

			await rm(lockFile, { force: true })
		}),
		clearLogs: vi.fn(async () => {
			order.push("clearLogs")

			if (failing.has(at("logs"))) {
				throw busy()
			}

			await removeTree(at("logs"))
		})
	} satisfies SignOutSteps
	const log = { info: vi.fn(), warn: vi.fn() }
	const remove = vi.fn((target: string) => {
		order.push(`remove ${path.relative(userData, target)}`)

		return failing.has(target) ? Promise.reject(busy()) : removeTree(target)
	})
	const signOut = createSignOut({
		steps,
		syncRoot: at("sync-engine"),
		mountsRoot: at("mounts"),
		lockFile,
		marker: atomicFile(at("signOut.pending")),
		remove,
		profile: () => options.profile ?? { result: "not-due" },
		log
	})
	const logged = () => [...log.info.mock.calls, ...log.warn.mock.calls].flat().join("\n")

	return { signOut, steps, log, logged, order, forgotten, failing, remove, lockFile }
}

// The marker as written: what is still pending.
async function marker(): Promise<unknown> {
	return existsSync(at("signOut.pending")) ? JSON.parse(await readFile(at("signOut.pending"), "utf8")) : null
}

function pendingOf(fields: { users?: Record<string, string[]>; stash?: boolean; lock?: boolean; logs?: boolean; profile?: boolean }) {
	return { version: 1, users: {}, stash: false, lock: false, logs: false, profile: false, ...fields }
}

describe("sign-out", () => {
	beforeEach(async () => {
		await seed(USER)
		await seed(OTHER)
		await writeFile(at("lock.vault"), "pin")
		await writeFile(at("migration.stash"), "stash")
		await mkdir(at("logs"))
		await writeFile(at("logs", "main.log"), "line")
		await writeFile(at("logs", "rclone.log"), "line")
	})

	it("deletes the user's directories, the stash, the app lock and the logs, nothing of another user's, and leaves the profile for the next launch", async () => {
		const { signOut, logged } = setup()

		await signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("migration.stash"))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("logs"))).toBe(false)
		expect(await marker()).toEqual(pendingOf({ profile: true }))
		expect(existsSync(at("sync-engine", OTHER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", OTHER, "credentials.bin"))).toBe(true)
		expect(existsSync(at("mounts", OTHER, "cache", "item"))).toBe(true)
		expect(logged()).not.toContain(USER)
	})

	it("deletes only once the host exited, after rclone and the stores; the lock, then the logs last", async () => {
		const { signOut, order, forgotten } = setup()

		await signOut.signOut(USER)

		expect(order).toEqual([
			"fileProvider",
			"mounts",
			"host exited",
			"forget",
			`remove ${path.join("sync-engine", USER)}`,
			`remove ${path.join("mounts", USER)}`,
			"discardStash",
			"resetLock",
			"clearLogs"
		])
		expect(forgotten).toEqual([[USER, ["sync", "mounts"]]])
	})

	it("keeps the whole mounts directory while its cache may hold uploads", async () => {
		const { signOut, order, forgotten, log } = setup({ mountsGo: false })

		await signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER, "cache", "item"))).toBe(true)
		expect(existsSync(at("mounts", USER, "state", "item"))).toBe(true)
		expect(existsSync(at("mounts", USER, "mounts.json"))).toBe(true)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(order).not.toContain(`remove ${path.join("mounts", USER)}`)
		expect(forgotten).toEqual([[USER, ["sync"]]])
		expect(log.info).toHaveBeenCalledWith("sign-out: network drive data kept for the uploads its cache may hold")

		// Not listed for the next start either.
		const next = setup()

		await next.signOut.resume()
		expect(existsSync(at("mounts", USER, "cache", "item"))).toBe(true)
	})

	it("counts a failed mounts step as uploads kept", async () => {
		const { signOut, steps } = setup()

		steps.mounts.mockRejectedValueOnce(new Error("gone"))
		await signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER, "cache", "item"))).toBe(true)
	})

	it("without a known user deletes what is nobody's: the stash, the app lock, the logs and the profile", async () => {
		const { signOut, steps, order } = setup()

		await signOut.signOut(null)

		expect(steps.mounts).not.toHaveBeenCalled()
		expect(order).toEqual(["fileProvider", "host exited", "discardStash", "resetLock", "clearLogs"])
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(await marker()).toEqual(pendingOf({ profile: true }))
		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", USER, "credentials.bin"))).toBe(true)
	})

	it("never joins anything but a plain user id to a path", async () => {
		const { signOut, remove } = setup()

		await signOut.signOut("../mounts")

		expect(remove).not.toHaveBeenCalled()
		expect(existsSync(at("mounts", USER))).toBe(true)
	})

	it("retries on the next start what could not be deleted, by step and code, the logs last", async () => {
		const failing = new Set([at("sync-engine", USER), at("lock.vault"), at("migration.stash"), at("logs")])
		const first = setup({ failing })

		await first.signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(true)
		expect(first.log.warn).toHaveBeenCalledWith("sign-out: sync data not deleted on sign-out, tried again next start: EBUSY")
		expect(first.log.warn).toHaveBeenCalledWith("sign-out: app lock not deleted on sign-out, tried again next start: EBUSY")
		expect(first.log.warn).toHaveBeenCalledWith("sign-out: old client's stash not deleted on sign-out, tried again next start: EBUSY")
		expect(await marker()).toEqual(pendingOf({ users: { [USER]: ["sync"] }, stash: true, lock: true, logs: true, profile: true }))

		const next = setup({ profile: { result: "deleted" } })

		await next.signOut.resume()

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("migration.stash"))).toBe(false)
		expect(existsSync(at("logs"))).toBe(false)
		expect(await marker()).toBeNull()
		expect(existsSync(at("sync-engine", OTHER, "baseline.db"))).toBe(true)
		expect(next.order.at(-1)).toBe("clearLogs")
		// Before the app lock is loaded: its file directly.
		expect(next.steps.resetLock).not.toHaveBeenCalled()
		expect(next.log.info).toHaveBeenCalledWith("sign-out: sync data left by a sign-out deleted")
		expect(next.log.info).toHaveBeenCalledWith("sign-out: browser profile deleted")
		expect(next.logged()).not.toContain(USER)
	})

	it("finishes on the next start a sign-out cut short after it listed its work", async () => {
		await writeFile(
			at("signOut.pending"),
			JSON.stringify(pendingOf({ users: { [USER]: ["sync", "mounts"] }, stash: true, lock: true, logs: true, profile: true }))
		)

		const { signOut, steps } = setup({ profile: { result: "deleted" } })

		await signOut.resume()

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("migration.stash"))).toBe(false)
		expect(existsSync(at("logs"))).toBe(false)
		expect(existsSync(at("mounts", OTHER, "credentials.bin"))).toBe(true)
		expect(steps.discardStash).toHaveBeenCalledOnce()
		expect(await marker()).toBeNull()
	})

	it("reads a marker written before the stash, logs and profile were listed", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify({ version: 1, users: { [USER]: ["sync"] }, lock: true }))

		const { signOut, steps } = setup()

		await signOut.resume()

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(steps.discardStash).not.toHaveBeenCalled()
		expect(steps.clearLogs).not.toHaveBeenCalled()
		expect(await marker()).toBeNull()
	})

	it("records the profile as the launch's early step left it", async () => {
		for (const [outcome, left] of [
			[{ result: "deleted" }, null],
			[{ result: "signed-in" }, null],
			[{ result: "failed", code: "EBUSY" }, pendingOf({ profile: true })],
			[{ result: "not-due" }, pendingOf({ profile: true })]
		] as const) {
			await writeFile(at("signOut.pending"), JSON.stringify(pendingOf({ profile: true })))

			const { signOut, log } = setup({ profile: outcome })

			await signOut.resume()
			expect(await marker()).toEqual(left)

			if (outcome.result === "failed") {
				expect(log.warn).toHaveBeenCalledWith("sign-out: browser profile not deleted, tried again next launch: EBUSY")
			}
		}
	})

	it("keeps a leftover in the marker while it still cannot be deleted", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify(pendingOf({ users: { [USER]: ["mounts"] } })))

		const { signOut } = setup({ failing: new Set([at("mounts", USER)]) })

		await signOut.resume()

		expect(await marker()).toEqual(pendingOf({ users: { [USER]: ["mounts"] } }))
	})

	it("drops an invalid marker and ignores user ids that are no plain number", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify(pendingOf({ users: { "..": ["sync"], [OTHER]: ["mounts"] } })))

		const first = setup()

		await first.signOut.resume()
		expect(first.remove).toHaveBeenCalledExactlyOnceWith(at("mounts", OTHER))
		expect(existsSync(at("sync-engine", USER))).toBe(true)

		await writeFile(at("signOut.pending"), "{")

		const second = setup()

		await second.signOut.resume()
		expect(second.remove).not.toHaveBeenCalled()
		expect(second.log.warn).toHaveBeenCalledWith("sign-out: wipe marker is invalid; dropped")
		expect(existsSync(at("signOut.pending"))).toBe(false)
	})

	it("starts with no marker without touching anything", async () => {
		const { signOut, remove, steps, log } = setup()

		await signOut.resume()

		expect(remove).not.toHaveBeenCalled()
		expect(steps.clearLogs).not.toHaveBeenCalled()
		expect(log.warn).not.toHaveBeenCalled()
		expect(existsSync(at("lock.vault"))).toBe(true)
		expect(existsSync(at("logs", "main.log"))).toBe(true)
	})

	it("hands the profile and the logs to a session signed in before the next launch, and deletes the user's leftovers first", async () => {
		const failing = new Set([at("sync-engine", USER), at("sync-engine", OTHER)])
		const { signOut, log } = setup({ failing })

		await signOut.signOut(OTHER)
		await signOut.signOut(USER)
		failing.delete(at("sync-engine", USER))
		await signOut.signedIn(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(log.info).toHaveBeenCalledWith("sign-out: browser profile kept, signed in again before a launch")
		// The other user's leftover stays listed; the profile is the new session's.
		expect(await marker()).toEqual(pendingOf({ users: { [OTHER]: ["sync"] } }))

		// What the new session writes survives the next start.
		await seed(USER)
		await mkdir(at("logs"), { recursive: true })
		await writeFile(at("logs", "main.log"), "new session")

		const next = setup({ profile: { result: "not-due" } })

		await next.signOut.resume()
		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("logs", "main.log"))).toBe(true)
		expect(existsSync(at("sync-engine", OTHER))).toBe(false)
	})

	it("gives a leftover that still cannot be deleted to the new session, but keeps a stash listed", async () => {
		const failing = new Set([at("sync-engine", USER), at("migration.stash")])
		const { signOut, log } = setup({ failing })

		await signOut.signOut(USER)
		await signOut.signedIn(USER)

		expect(log.warn).toHaveBeenCalledWith("sign-out: sync data not deleted before a sign-in, kept: EBUSY")
		// Nothing writes the stash again, so deleting it later can never take the new session's data.
		expect(await marker()).toEqual(pendingOf({ stash: true }))
	})

	it("lists the profile when a sign-out begins, deleting nothing, so one cut short there still loses it next launch", async () => {
		const { signOut, remove, steps } = setup()

		await signOut.begin()

		expect(await marker()).toEqual(pendingOf({ profile: true }))
		expect(remove).not.toHaveBeenCalled()
		expect(steps.stopHost).not.toHaveBeenCalled()
		expect(existsSync(at("lock.vault"))).toBe(true)

		// The sign-out then runs as ever; a sign-in afterwards keeps the profile for the new session.
		await signOut.signOut(USER)
		expect(await marker()).toEqual(pendingOf({ profile: true }))
		await signOut.signedIn(USER)
		expect(await marker()).toBeNull()
	})

	it("signs in with nothing pending without any file access", async () => {
		const { signOut, remove, steps } = setup()

		await signOut.signedIn(USER)

		expect(remove).not.toHaveBeenCalled()
		expect(steps.resetLock).not.toHaveBeenCalled()
		expect(steps.clearLogs).not.toHaveBeenCalled()
		expect(existsSync(at("signOut.pending"))).toBe(false)
	})
})

describe("the browser profile before ready", () => {
	function deps(text: string | null, overrides: Partial<ProfileWipeDeps> = {}) {
		return {
			readMarker: vi.fn(() => text),
			sessionStored: vi.fn(() => false),
			deleteProfile: vi.fn(() => {
				deleteProfileStorage(userData)
			}),
			...overrides
		} satisfies ProfileWipeDeps
	}

	// Every entry the list names, plus what must stay: the app's files and Chromium's own state.
	async function profile(): Promise<string[]> {
		for (const entry of PROFILE_ENTRIES) {
			await mkdir(path.dirname(at(entry)), { recursive: true })

			if (/Cookies|journal|wal|SharedStorage$/.test(entry)) {
				await writeFile(at(entry), "data")
			} else {
				await mkdir(at(entry), { recursive: true })
				await writeFile(at(entry, "data"), "data")
			}
		}

		const kept = ["prefs.json", "migration.json", "Local State", "Preferences", path.join("Network", "Network Persistent State")]

		for (const file of kept) {
			await writeFile(at(file), "{}")
		}

		await seed(OTHER)

		return [...kept, path.join("sync-engine", OTHER, "shell.json"), path.join("mounts", OTHER, "credentials.bin")]
	}

	const DUE = JSON.stringify(pendingOf({ profile: true }))

	it("deletes the storage, cookies and caches of a sign-out, keeping the app's files and Chromium's state", async () => {
		const kept = await profile()

		expect(wipeProfileBeforeReady(deps(DUE))).toEqual({ result: "deleted" })

		for (const entry of PROFILE_ENTRIES) {
			expect(existsSync(at(entry)), entry).toBe(false)
		}

		for (const file of kept) {
			expect(existsSync(at(file)), file).toBe(true)
		}
	})

	it("names localStorage, IndexedDB, OPFS, service workers with Cache Storage, cookies and the caches", () => {
		expect(PROFILE_ENTRIES).toEqual(
			expect.arrayContaining([
				"Local Storage",
				"Session Storage",
				"IndexedDB",
				"File System",
				"Service Worker",
				"Cookies",
				path.join("Network", "Cookies"),
				"Cache",
				"Code Cache",
				"GPUCache"
			])
		)
	})

	it("does nothing without a sign-out listed, nor with an unreadable or invalid marker", async () => {
		for (const text of [null, JSON.stringify(pendingOf({ lock: true })), "{"]) {
			const run = deps(text)

			expect(wipeProfileBeforeReady(run)).toEqual({ result: "not-due" })
			expect(run.deleteProfile).not.toHaveBeenCalled()
		}

		const unreadable = deps(null, {
			readMarker: () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" })
			}
		})

		expect(wipeProfileBeforeReady(unreadable)).toEqual({ result: "not-due" })
		expect(unreadable.deleteProfile).not.toHaveBeenCalled()
	})

	it("keeps the profile of a session stored since the sign-out", () => {
		const run = deps(DUE, { sessionStored: () => true })

		expect(wipeProfileBeforeReady(run)).toEqual({ result: "signed-in" })
		expect(run.deleteProfile).not.toHaveBeenCalled()
	})

	it("reports a Windows-like EBUSY, so the next launch tries again", () => {
		const run = deps(DUE, {
			deleteProfile: () => {
				throw busy()
			}
		})

		expect(wipeProfileBeforeReady(run)).toEqual({ result: "failed", code: "EBUSY" })
	})

	it("tries every entry before it reports the first failure", () => {
		const tried: string[] = []

		expect(() => {
			deleteProfileStorage(userData, target => {
				tried.push(target)

				if (target === at("IndexedDB") || target === at("Cache")) {
					throw busy()
				}
			})
		}).toThrow("resource busy or locked")
		expect(tried).toEqual(PROFILE_ENTRIES.map(entry => at(entry)))
	})
})
