import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { effectiveConfig, type LegacyStash } from "../main/legacyData.ts"
import { attachUnheld } from "../main/sync/firstRun.ts"
import {
	DOT_FILE_RULES,
	legacyRecords,
	legacyStateDir,
	legacySyncImport,
	legacyUserIgnore,
	type LegacyPair,
	withRules
} from "../main/sync/legacyPairs.ts"
import { fakeNative, memoryStore } from "./syncFakes.ts"

const ACCOUNT_ROOT = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"
const REMOTE = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const REMOTE_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const UUID_A = "11111111-2222-4333-8444-555555555555"
const UUID_B = "22222222-3333-4444-8555-666666666666"

let directory: string

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-legacy-pairs-")))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

// The old client's stored pair.
function oldPair(overrides: Record<string, unknown> = {}) {
	return {
		name: "Docs",
		uuid: UUID_A,
		localPath: "/Users/u/Docs",
		remotePath: "/Docs",
		remoteParentUUID: REMOTE,
		mode: "twoWay",
		excludeDotFiles: false,
		paused: false,
		localTrashDisabled: false,
		requireConfirmationOnLargeDeletion: true,
		...overrides
	}
}

function legacyPair(overrides: Partial<LegacyPair> = {}): LegacyPair {
	return {
		uuid: UUID_A,
		name: "Docs",
		localPath: "/Users/u/Docs",
		remoteRoot: REMOTE,
		mode: "twoWay",
		excludeDotFiles: false,
		paused: false,
		localTrashDisabled: false,
		...overrides
	}
}

function lines(text: string): string[] {
	return text.split("\n").filter(line => line.length > 0)
}

describe("legacySyncImport", () => {
	it("modes map 1:1", () => {
		const modes = ["twoWay", "localToCloud", "cloudToLocal", "localBackup", "cloudBackup"]
		const imported = legacySyncImport({
			enabled: true,
			dbPath: "/old",
			syncPairs: modes.map((mode, index) => oldPair({ mode, uuid: `${String(index)}${UUID_A.slice(1)}` }))
		})

		expect(imported?.pairs.map(pair => pair.mode)).toEqual(["twoWay", "localToRemote", "remoteToLocal", "localBackup", "remoteBackup"])
	})

	it("drops entries that are no pair, and a pair listed twice", () => {
		const imported = legacySyncImport({
			enabled: false,
			syncPairs: [oldPair(), oldPair({ mode: "mirror" }), oldPair({ localPath: "" }), oldPair(), 7]
		})

		expect(imported).toEqual({ enabled: false, pairs: [legacyPair()], dropped: 4 })
		expect(legacySyncImport({ syncPairs: [] })).toBeNull()
		expect(legacySyncImport(undefined)).toBeNull()
	})

	it("effective config fallback only for the stashed user", () => {
		const config = { enabled: true, syncPairs: [oldPair()] }
		const stash: LegacyStash = {
			version: 1,
			userId: 1001,
			users: { sync: { "1002": { enabled: true, syncPairs: [] } }, networkDrive: {}, webdav: {}, s3: {} },
			fallback: { sync: config }
		}

		expect(legacySyncImport(effectiveConfig(stash, "1001", "sync"))?.pairs).toHaveLength(1)
		expect(legacySyncImport(effectiveConfig(stash, "1002", "sync"))?.pairs).toEqual([])
		expect(effectiveConfig(stash, "1003", "sync")).toBeUndefined()
	})
})

describe("legacyRecords", () => {
	it("records an account-root pair like any other, and it is added", async () => {
		const imported = legacySyncImport({
			enabled: true,
			syncPairs: [oldPair({ remoteParentUUID: ACCOUNT_ROOT.toUpperCase(), localPath: directory })]
		})

		expect(imported).not.toBeNull()

		const records = legacyRecords(imported ?? { enabled: true, pairs: [], dropped: 0 }, 5)

		expect(records).toEqual([
			{
				pairId: null,
				name: "Docs",
				localRoot: directory,
				remoteRoot: ACCOUNT_ROOT.toUpperCase(),
				mode: "twoWay",
				paused: false,
				state: "waitingForRoot",
				review: null,
				legacyUuid: UUID_A,
				legacyDotFiles: null,
				notices: ["localTrashMoved"],
				createdAt: 5
			}
		])

		const store = memoryStore(records)
		const { deps, argsOf } = fakeNative(store)

		await attachUnheld(deps)
		expect(argsOf("addPair")).toEqual([{ localRoot: directory, remoteRoot: ACCOUNT_ROOT.toUpperCase(), mode: "twoWay" }])
		expect(store.get().pairs[0]).toMatchObject({ pairId: "1", state: "active", notices: ["localTrashMoved"] })
	})

	it("keeps an old pair paused when it or the old sync switch was off, and names it", () => {
		const records = legacyRecords(
			{
				enabled: false,
				pairs: [
					legacyPair({ name: "  ", localPath: "C:\\Users\\u\\Photos", localTrashDisabled: true }),
					legacyPair({ uuid: UUID_B, paused: true })
				],
				dropped: 0
			},
			0
		)

		expect(records.map(pair => [pair.name, pair.paused, pair.state, pair.notices])).toEqual([
			["Photos", true, "waitingForRoot", []],
			["Docs", true, "waitingForRoot", ["localTrashMoved"]]
		])
	})
})

describe("legacyStateDir", () => {
	it("is the pair's directory under the old client's sync state", () => {
		expect(legacyStateDir(path.join("/data", "@filen", "desktop"), UUID_A)).toBe(
			path.join("/data", "@filen", "desktop", "sync", "state", "v2", UUID_A)
		)
	})
})

describe("dot files and the old trash", () => {
	it("uniform excludeDotFiles goes device-wide", async () => {
		const pairs = [
			legacyPair({ excludeDotFiles: true, localPath: directory }),
			legacyPair({ uuid: UUID_B, excludeDotFiles: true, remoteRoot: REMOTE_B })
		]

		expect(lines(legacyUserIgnore(pairs, ""))).toEqual([...DOT_FILE_RULES])

		const records = legacyRecords({ enabled: true, pairs, dropped: 0 }, 0)

		expect(records.map(pair => pair.legacyDotFiles)).toEqual(["device", "device"])

		// No rule file is written into the pair and the clean run starts it.
		const store = memoryStore(records.slice(0, 1))
		const { deps, argsOf } = fakeNative(store)

		await attachUnheld(deps)
		expect(argsOf("evaluatePlan")).toEqual([{ pairId: "1", check: { legacy: { excludeDotFiles: true } } }])
		expect(store.get().pairs[0]).toMatchObject({ state: "active", paused: false })
		await expect(readFile(path.join(directory, ".filenignore"), "utf8")).rejects.toThrow()
	})

	it("mixed excludeDotFiles goes to review", async () => {
		const hidden = path.join(directory, "hidden")
		const shown = path.join(directory, "shown")

		await mkdir(hidden)
		await mkdir(shown)
		await writeFile(path.join(hidden, ".filenignore"), "build/")

		const pairs = [
			legacyPair({ excludeDotFiles: true, localPath: hidden }),
			legacyPair({ uuid: UUID_B, excludeDotFiles: false, localPath: shown, remoteRoot: REMOTE_B })
		]

		// Nothing goes device-wide.
		expect(legacyUserIgnore(pairs, "")).toBe("")

		const store = memoryStore(legacyRecords({ enabled: true, pairs, dropped: 0 }, 0))
		const { deps } = fakeNative(store)

		await attachUnheld(deps)

		// The pair that hid dot files gets its own rule file (the user's lines kept) and waits for the user even
		// though its run is clean; the other one starts.
		expect(await readFile(path.join(hidden, ".filenignore"), "utf8")).toBe("build/\n.*\n!/.filenignore\n")
		expect(await readFile(path.join(shown, ".filenignore"), "utf8").catch(() => null)).toBeNull()
		expect(store.get().pairs.map(pair => [pair.state, pair.paused, pair.review?.findings ?? null])).toEqual([
			["review", true, ["dotFilesPerPair"]],
			["active", false, null]
		])
	})

	it("adds no rule for the old trash, which the engine reserves", () => {
		expect(legacyUserIgnore([legacyPair()], "")).toBe("")
		expect(legacyUserIgnore([], "")).toBe("")
	})

	it("no other old patterns added", () => {
		const text = legacyUserIgnore([legacyPair({ excludeDotFiles: true })], "")

		for (const pattern of ["*.tmp", "*.temp", "*.ffs_tmp", "*.temporary", "*.~cr", "*.thumbdata", "*.crswap", "ntuser.dat"]) {
			expect(text).not.toContain(pattern)
		}
	})

	it("keeps the user's lines and adds nothing twice", () => {
		const existing = "# mine\r\nnode_modules/\n.filen.trash.local/"

		expect(legacyUserIgnore([legacyPair()], existing)).toBe(existing)

		const once = legacyUserIgnore([legacyPair({ excludeDotFiles: true })], existing)

		expect(once).toBe(`${existing}\n.*\n!/.filenignore\n`)
		expect(legacyUserIgnore([legacyPair({ excludeDotFiles: true })], once)).toBe(once)
	})

	it("re-adds a negation after the rule it negates", () => {
		expect(withRules("!/.filenignore\n", [DOT_FILE_RULES])).toBe("!/.filenignore\n.*\n!/.filenignore\n")
		expect(withRules(".*\n", [DOT_FILE_RULES])).toBe(".*\n!/.filenignore\n")
	})
})
