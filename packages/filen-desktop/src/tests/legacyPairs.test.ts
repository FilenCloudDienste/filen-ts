import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { effectiveConfig, type LegacyStash } from "../main/legacyData.ts"
import { attachUnheld, startPreparing } from "../main/sync/firstRun.ts"
import {
	DOT_FILE_RULES,
	LEGACY_BUILTIN_RULES,
	legacyPairRules,
	legacyRecords,
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
			syncPairs: modes.map((mode, index) =>
				oldPair({ mode, uuid: `${String(index)}${UUID_A.slice(1)}`, remoteParentUUID: `${String(index)}${REMOTE.slice(1)}` })
			)
		})

		expect(imported?.pairs.map(pair => pair.mode)).toEqual(["twoWay", "localToRemote", "remoteToLocal", "localBackup", "remoteBackup"])
	})

	it("drops entries that are no pair, and merges a pair listed twice or another on the same directories", () => {
		const imported = legacySyncImport({
			enabled: false,
			syncPairs: [
				oldPair(),
				oldPair({ mode: "mirror" }),
				oldPair({ localPath: "" }),
				oldPair(),
				oldPair({ uuid: UUID_B, mode: "localBackup", localPath: "/USERS/u/Docs", remoteParentUUID: REMOTE.toUpperCase() }),
				7
			]
		})

		expect(imported).toEqual({ enabled: false, pairs: [legacyPair()], dropped: 3, merged: 2 })
		expect(legacySyncImport({ syncPairs: [] })).toBeNull()
		expect(legacySyncImport(undefined)).toBeNull()
	})

	it("reads switches early builds did not store as off, and any other value as the old client did", () => {
		const { excludeDotFiles: _dot, paused: _paused, localTrashDisabled: _trash, name: _name, ...bare } = oldPair()
		const imported = legacySyncImport({
			enabled: true,
			syncPairs: [bare, oldPair({ uuid: UUID_B, remoteParentUUID: REMOTE_B, paused: 1, excludeDotFiles: "yes" })]
		})

		expect(imported?.pairs).toEqual([
			legacyPair({ name: "" }),
			legacyPair({ uuid: UUID_B, remoteRoot: REMOTE_B, paused: true, excludeDotFiles: true })
		])
		expect(imported?.dropped).toBe(0)
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

		const records = legacyRecords(imported ?? { enabled: true, pairs: [], dropped: 0, merged: 0 }, new Map(), 5)

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
				legacyRules: null,
				notices: [],
				rootProblem: null,
				holds: [],
				wholeDriveConfirmed: false,
				info: [],
				createdAt: 5
			}
		])

		const store = memoryStore(records)
		const { deps, argsOf } = fakeNative(store)

		await attachUnheld(deps)
		expect(argsOf("addPair")).toEqual([{ localRoot: directory, remoteRoot: ACCOUNT_ROOT.toUpperCase(), mode: "twoWay" }])
		expect(store.get().pairs[0]).toMatchObject({ pairId: "1", state: "preparing", paused: false })
		await expect(startPreparing(deps)).resolves.toEqual({ started: "1", waiting: true })
		expect(store.get().pairs[0]).toMatchObject({ pairId: "1", state: "active", paused: false, notices: [] })
	})

	it("keeps an old pair paused when it or the old sync switch was off, names it, and tells about the bin", () => {
		const records = legacyRecords(
			{
				enabled: false,
				pairs: [
					legacyPair({ name: "  ", localPath: "C:\\Users\\u\\Photos", localTrashDisabled: true }),
					legacyPair({ uuid: UUID_B, paused: true })
				],
				dropped: 0,
				merged: 0
			},
			new Map(),
			0
		)

		expect(records.map(pair => [pair.name, pair.paused, pair.state, pair.notices, pair.info])).toEqual([
			["Photos", true, "waitingForRoot", [], ["localTrashNowOn"]],
			["Docs", true, "waitingForRoot", [], []]
		])
	})
})

describe("rules carried over", () => {
	it("every pair that hid dot files gets them in its own rule file, in every mode; nothing goes device-wide", async () => {
		const modes = ["twoWay", "localToRemote", "remoteToLocal", "localBackup", "remoteBackup"] as const
		const roots = await Promise.all(
			modes.map(async mode => {
				const root = path.join(directory, mode)

				await mkdir(root)

				return root
			})
		)

		await writeFile(path.join(roots[0] ?? "", ".filenignore"), "build/")

		const pairs = modes.map((mode, index) =>
			legacyPair({
				uuid: `${String(index)}${UUID_A.slice(1)}`,
				mode,
				excludeDotFiles: true,
				localPath: roots[index] ?? "",
				remoteRoot: `${String(index)}${REMOTE.slice(1)}`
			})
		)

		expect(legacyUserIgnore(pairs, "")).not.toContain(".*")

		const store = memoryStore(legacyRecords({ enabled: true, pairs, dropped: 0, merged: 0 }, new Map(), 0))
		const { deps } = fakeNative(store)

		await attachUnheld(deps)

		// Before any first run; the user's lines kept.
		expect(await readFile(path.join(roots[0] ?? "", ".filenignore"), "utf8")).toBe("build/\n.*\n!/.filenignore\n")

		for (const root of roots.slice(1)) {
			expect(await readFile(path.join(root, ".filenignore"), "utf8")).toBe(".*\n!/.filenignore\n")
		}

		expect(store.get().pairs.map(pair => pair.state)).toEqual(modes.map(() => "preparing"))
	})

	it("a pair that showed dot files gets no rule file", async () => {
		const store = memoryStore(
			legacyRecords({ enabled: true, pairs: [legacyPair({ localPath: directory })], dropped: 0, merged: 0 }, new Map(), 0)
		)
		const { deps } = fakeNative(store)

		await attachUnheld(deps)
		await expect(readFile(path.join(directory, ".filenignore"), "utf8")).rejects.toThrow()
	})

	it("appends the old per-pair ignore file before the dot-file rules", () => {
		expect(legacyPairRules(legacyPair({ excludeDotFiles: true }), "node_modules/\r\n\r\n  *.log  \n")).toEqual([
			"node_modules/",
			"*.log",
			...DOT_FILE_RULES
		])
		expect(legacyPairRules(legacyPair(), "")).toBeNull()
		expect(legacyPairRules(legacyPair(), null)).toBeNull()
	})

	it("adds the old client's built-in ignores device-wide, once, keeping the user's lines", () => {
		const existing = "# mine\r\nnode_modules/\n*.tmp"
		const once = legacyUserIgnore([legacyPair()], existing)

		expect(lines(once)).toEqual(["# mine\r", "node_modules/", ...LEGACY_BUILTIN_RULES])
		expect(legacyUserIgnore([legacyPair()], once)).toBe(once)
		expect(legacyUserIgnore([], existing)).toBe(existing)
	})

	it("re-adds a negation after the rule it negates", () => {
		expect(withRules("!/.filenignore\n", [DOT_FILE_RULES])).toBe("!/.filenignore\n.*\n!/.filenignore\n")
		expect(withRules(".*\n", [DOT_FILE_RULES])).toBe(".*\n!/.filenignore\n")
	})
})
