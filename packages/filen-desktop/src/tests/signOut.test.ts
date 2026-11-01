import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { atomicFile } from "../main/atomicFile.ts"
import { createSignOut, removeTree, type SignOutSteps, type WipePart } from "../main/signOut.ts"

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

function setup(options: { mountsGo?: boolean; failing?: Set<string> } = {}) {
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
		resetLock: vi.fn(async () => {
			order.push("resetLock")

			if (failing.has(lockFile)) {
				throw busy()
			}

			await rm(lockFile, { force: true })
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
		log
	})
	const logged = () => [...log.info.mock.calls, ...log.warn.mock.calls].flat().join("\n")

	return { signOut, steps, log, logged, order, forgotten, failing, remove, lockFile }
}

describe("sign-out", () => {
	beforeEach(async () => {
		await seed(USER)
		await seed(OTHER)
		await writeFile(at("lock.vault"), "pin")
	})

	it("deletes the user's sync and mounts directories and the app lock, and nothing of another user's", async () => {
		const { signOut, logged } = setup()

		await signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("signOut.pending"))).toBe(false)
		expect(existsSync(at("sync-engine", OTHER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", OTHER, "credentials.bin"))).toBe(true)
		expect(existsSync(at("mounts", OTHER, "cache", "item"))).toBe(true)
		expect(logged()).not.toContain(USER)
	})

	it("deletes only once the host exited, after rclone and the stores, and the app lock last", async () => {
		const { signOut, order, forgotten } = setup()

		await signOut.signOut(USER)

		expect(order).toEqual([
			"fileProvider",
			"mounts",
			"host exited",
			"forget",
			`remove ${path.join("sync-engine", USER)}`,
			`remove ${path.join("mounts", USER)}`,
			"resetLock"
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

	it("without a known user removes the app lock only", async () => {
		const { signOut, steps, order } = setup()

		await signOut.signOut(null)

		expect(steps.mounts).not.toHaveBeenCalled()
		expect(order).toEqual(["fileProvider", "host exited", "resetLock"])
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", USER, "credentials.bin"))).toBe(true)
	})

	it("never joins anything but a plain user id to a path", async () => {
		const { signOut, remove } = setup()

		await signOut.signOut("../mounts")

		expect(remove).not.toHaveBeenCalled()
		expect(existsSync(at("mounts", USER))).toBe(true)
	})

	it("retries on the next start what could not be deleted, by step and code", async () => {
		const failing = new Set([at("sync-engine", USER), at("lock.vault")])
		const first = setup({ failing })

		await first.signOut.signOut(USER)

		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(true)
		expect(first.log.warn).toHaveBeenCalledWith("sign-out: sync data not deleted on sign-out, tried again next start: EBUSY")
		expect(first.log.warn).toHaveBeenCalledWith("sign-out: app lock not removed on sign-out, tried again next start: EBUSY")
		expect(JSON.parse(await readFile(at("signOut.pending"), "utf8"))).toEqual({ version: 1, users: { [USER]: ["sync"] }, lock: true })

		const next = setup()

		await next.signOut.resume()

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("signOut.pending"))).toBe(false)
		expect(existsSync(at("sync-engine", OTHER, "baseline.db"))).toBe(true)
		expect(next.log.info).toHaveBeenCalledWith("sign-out: sync data left by a sign-out deleted")
		expect(next.logged()).not.toContain(USER)
	})

	it("finishes on the next start a sign-out cut short after it listed its work", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify({ version: 1, users: { [USER]: ["sync", "mounts"] }, lock: true }))

		const { signOut, steps } = setup()

		await signOut.resume()

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		expect(existsSync(at("mounts", USER))).toBe(false)
		expect(existsSync(at("lock.vault"))).toBe(false)
		expect(existsSync(at("mounts", OTHER, "credentials.bin"))).toBe(true)
		// Before the app lock is loaded: its file directly.
		expect(steps.resetLock).not.toHaveBeenCalled()
		expect(existsSync(at("signOut.pending"))).toBe(false)
	})

	it("keeps a leftover in the marker while it still cannot be deleted", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify({ version: 1, users: { [USER]: ["mounts"] }, lock: false }))

		const { signOut } = setup({ failing: new Set([at("mounts", USER)]) })

		await signOut.resume()

		expect(JSON.parse(await readFile(at("signOut.pending"), "utf8"))).toEqual({
			version: 1,
			users: { [USER]: ["mounts"] },
			lock: false
		})
	})

	it("drops an invalid marker and ignores user ids that are no plain number", async () => {
		await writeFile(at("signOut.pending"), JSON.stringify({ version: 1, users: { "..": ["sync"], [OTHER]: ["mounts"] }, lock: false }))

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
		const { signOut, remove, log } = setup()

		await signOut.resume()

		expect(remove).not.toHaveBeenCalled()
		expect(log.warn).not.toHaveBeenCalled()
		expect(existsSync(at("lock.vault"))).toBe(true)
	})

	it("deletes a leftover of the user before they sign in again, and never later", async () => {
		const failing = new Set([at("sync-engine", USER), at("sync-engine", OTHER)])
		const { signOut } = setup({ failing })

		await signOut.signOut(OTHER)
		await signOut.signOut(USER)
		failing.delete(at("sync-engine", USER))
		await signOut.signedIn(USER)

		expect(existsSync(at("sync-engine", USER))).toBe(false)
		// The other user's leftover stays listed.
		expect(JSON.parse(await readFile(at("signOut.pending"), "utf8"))).toEqual({ version: 1, users: { [OTHER]: ["sync"] }, lock: false })

		// What the new session writes survives the next start.
		await seed(USER)

		const next = setup()

		await next.signOut.resume()
		expect(existsSync(at("sync-engine", USER, "baseline.db"))).toBe(true)
		expect(existsSync(at("sync-engine", OTHER))).toBe(false)
	})

	it("gives a leftover that still cannot be deleted to the new session rather than delete its data later", async () => {
		const failing = new Set([at("sync-engine", USER)])
		const { signOut, log } = setup({ failing })

		await signOut.signOut(USER)
		await signOut.signedIn(USER)

		expect(log.warn).toHaveBeenCalledWith("sign-out: sync data not deleted before a sign-in, kept: EBUSY")
		expect(existsSync(at("signOut.pending"))).toBe(false)
	})

	it("signs in with nothing pending without any file access", async () => {
		const { signOut, remove, steps } = setup()

		await signOut.signedIn(USER)

		expect(remove).not.toHaveBeenCalled()
		expect(steps.resetLock).not.toHaveBeenCalled()
		expect(existsSync(at("signOut.pending"))).toBe(false)
	})
})
