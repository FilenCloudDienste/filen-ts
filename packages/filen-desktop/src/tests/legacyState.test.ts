import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readLegacyIgnorer, retireLegacySyncState } from "../main/sync/legacyState.ts"

const UUID = "11111111-2222-4333-8444-555555555555"
// 2026-10-31, mid-day UTC.
const NOW = Date.UTC(2026, 9, 31, 12)

let userData: string

beforeEach(async () => {
	userData = await realpath(await mkdtemp(path.join(tmpdir(), "filen-legacy-state-")))
})

afterEach(async () => {
	await chmod(userData, 0o700)
	await rm(userData, { recursive: true, force: true })
})

async function oldState(directory = "sync"): Promise<void> {
	const ignorer = path.join(userData, directory, "ignorer", "v1", UUID)

	await mkdir(ignorer, { recursive: true })
	await writeFile(path.join(ignorer, "filenIgnore"), "*.log\n")
	await mkdir(path.join(userData, directory, "state", "v2", UUID), { recursive: true })
}

describe("retireLegacySyncState", () => {
	it("renames the old sync state to sync.migrated-<date>, keeping all of it", async () => {
		await oldState()

		await expect(retireLegacySyncState(userData, NOW)).resolves.toEqual({ renamedTo: "sync.migrated-2026-10-31" })
		expect((await readdir(userData)).sort()).toEqual(["sync.migrated-2026-10-31"])
		expect(await readdir(path.join(userData, "sync.migrated-2026-10-31"))).toEqual(expect.arrayContaining(["ignorer", "state"]))
	})

	it("does nothing when there is no old sync state, or it was renamed already", async () => {
		await expect(retireLegacySyncState(userData, NOW)).resolves.toBe("absent")

		await oldState()
		await retireLegacySyncState(userData, NOW)
		await expect(retireLegacySyncState(userData, NOW)).resolves.toBe("absent")
		expect(await readdir(userData)).toEqual(["sync.migrated-2026-10-31"])
	})

	it("adds a suffix when the name is taken, never replacing what is there", async () => {
		await oldState("sync.migrated-2026-10-31")
		await oldState("sync.migrated-2026-10-31-2")
		await oldState()

		await expect(retireLegacySyncState(userData, NOW)).resolves.toEqual({ renamedTo: "sync.migrated-2026-10-31-3" })
		expect((await readdir(userData)).sort()).toEqual([
			"sync.migrated-2026-10-31",
			"sync.migrated-2026-10-31-2",
			"sync.migrated-2026-10-31-3"
		])
	})

	it("throws when it cannot rename, leaving the state where it is for the next try", async () => {
		await oldState()
		await chmod(userData, 0o500)

		await expect(retireLegacySyncState(userData, NOW)).rejects.toThrow()

		await chmod(userData, 0o700)
		expect(await readdir(userData)).toEqual(["sync"])
		await expect(retireLegacySyncState(userData, NOW)).resolves.toEqual({ renamedTo: "sync.migrated-2026-10-31" })
	})
})

describe("readLegacyIgnorer", () => {
	it("reads a pair's old ignore file, also once the state was renamed", async () => {
		const warn = vi.fn()

		await expect(readLegacyIgnorer(userData, UUID, warn)).resolves.toBeNull()

		await oldState()
		await expect(readLegacyIgnorer(userData, UUID, warn)).resolves.toBe("*.log\n")

		await retireLegacySyncState(userData, NOW)
		await expect(readLegacyIgnorer(userData, UUID, warn)).resolves.toBe("*.log\n")
		expect(warn).not.toHaveBeenCalled()
	})

	it("skips a file that is no UTF-8 text", async () => {
		await oldState()
		await writeFile(path.join(userData, "sync", "ignorer", "v1", UUID, "filenIgnore"), Buffer.from([0xff]))

		const warn = vi.fn()

		await expect(readLegacyIgnorer(userData, UUID, warn)).resolves.toBeNull()
		expect(warn).toHaveBeenCalledOnce()
		expect(await readFile(path.join(userData, "sync", "ignorer", "v1", UUID, "filenIgnore"))).toEqual(Buffer.from([0xff]))
	})
})
