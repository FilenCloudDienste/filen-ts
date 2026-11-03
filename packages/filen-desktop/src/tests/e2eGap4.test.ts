import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import type { Page } from "playwright-core"
import { afterEach, describe, expect, it } from "vitest"
import {
	binDays,
	binPathParts,
	conflictsAllowed,
	cloudEdit,
	expectedBin,
	expectedSides,
	GAP4_DIR,
	HELD,
	keptAside,
	localEdit,
	seedConflictsCheck,
	under
} from "../../scripts/ci/e2e/chains/conflictsCheck.ts"
import {
	CLOSED_UPLOAD,
	driveRootChanges,
	firstRunProblems,
	firstRunSettled,
	LEGACY_FIRST_RUN,
	ROOT_PAIR,
	rootPairFile,
	type ShellPairState
} from "../../scripts/ci/e2e/chains/legacyHolds.ts"
import type { CloudEntry } from "../../scripts/ci/e2e/cloud.ts"
import { fixtureTree, LEGACY_PAIRS, treeSnapshot, writeTree } from "../../scripts/ci/e2e/fixtures.ts"
import { addLegacyPair, type LegacySyncPair } from "../../scripts/ci/e2e/legacyApp.ts"
import { diffSnapshots, localSnapshot } from "../../scripts/ci/e2e/snapshot.ts"
import { binPathFromToast, findingText, syncCount, syncText } from "../../scripts/ci/e2e/syncUi.ts"
import { LEGACY_KEYS } from "../../src/main/legacyData.ts"
import { legacySyncImport } from "../../src/main/sync/legacyPairs.ts"

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-gap4-"))

	dirs.push(dir)

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("e2e sync page labels", () => {
	it("fills the web catalog's values and plurals", () => {
		expect(syncText("conflictKeptRemoteBinned", { path: "/a/b.txt" })).toBe(
			"Kept the cloud's version. This device's version is in the pair's bin: /a/b.txt"
		)
		expect(syncCount("conflictsKeptAllBoth", 3)).toBe("Kept both versions of 3 items.")
		expect(syncCount("conflictsKeptAllBoth", 1)).toBe("Kept both versions of 1 item.")
		expect(syncText("heldApprovedPaused")).toBe("Approved. Applies when you resume.")
		expect(findingText("heldDeletions")).toBe("It deletes items.")
		expect(() => syncCount("heldTitle", 2)).toThrow(/no heldTitle_other/)
	})

	it("reads the bin path out of a Keep the cloud's toast, and nothing out of one without it", () => {
		const posix = `/home/runner/FilenE2E/run/previous/e2e-twoway/.filen-sync-trash/2026-11-03/${GAP4_DIR}/keep-cloud.txt`
		const windows = "C:\\Users\\runner\\FilenE2E\\run\\previous\\e2e-twoway\\.filen-sync-trash\\2026-11-03\\gap4\\keep-cloud.txt"

		expect(binPathFromToast(syncText("conflictKeptRemoteBinned", { path: posix }))).toBe(posix)
		expect(binPathFromToast(` ${syncText("conflictKeptRemoteBinned", { path: windows })} `)).toBe(windows)
		expect(binPathFromToast(syncText("conflictKeptRemote"))).toBeNull()
		expect(binPathParts(posix)).toEqual({ day: "2026-11-03", relPath: "gap4/keep-cloud.txt" })
		expect(binPathParts(windows)).toEqual({ day: "2026-11-03", relPath: "gap4/keep-cloud.txt" })
		expect(binPathParts("/home/runner/e2e-twoway/gap4/keep-cloud.txt")).toBeNull()
		expect(binPathParts("/root/.filen-sync-trash/2026-11-03")).toBeNull()
	})

	it("takes the UTC day buckets within a day of now, across midnight and a month's end", () => {
		expect(binDays(Date.parse("2026-11-30T23:59:30Z"))).toEqual(["2026-11-29", "2026-11-30", "2026-12-01"])
		expect(binDays(Date.parse("2026-11-03T00:00:10Z"))).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"])
	})
})

describe("P12 conflicts and held deletions", () => {
	it("seeds thirty held files, more than the engine's guard lets one pass delete in the two-way tree", () => {
		const tree = fixtureTree("previous/e2e-twoway", false)

		seedConflictsCheck(tree)

		const tracked = treeSnapshot(tree)
		const files = [...tracked.values()].filter(node => node.kind === "file").length
		// The engine's guard: max(10, 0.5 x tracked) per pass, whether it counts directories or files only.
		const limit = (count: number) => Math.max(10, 0.5 * count)

		expect(HELD).toHaveLength(30)
		expect(HELD.every(relPath => tree.files.has(relPath))).toBe(true)
		expect(tree.files.size).toBe(6 + 5 + 30)
		expect(HELD.length).toBeGreaterThan(limit(tracked.size + 1))
		expect(HELD.length).toBeGreaterThan(limit(files + 1))
	})

	it("expects each side's edit where it was kept and Keep both's copy beside the cloud's", () => {
		const sides = expectedSides()
		const sha = (relPath: string) => sides.get(relPath)?.sha256
		const of = (bytes: Buffer) => treeSnapshot({ files: new Map([["x", bytes]]), emptyDirs: [] }).get("x")?.sha256

		expect(keptAside("gap4/bulk-1.txt")).toBe("gap4/bulk-1.old.txt")
		expect([...sides.keys()].sort()).toEqual(
			[
				"gap4",
				"gap4/keep-local.txt",
				"gap4/keep-cloud.txt",
				"gap4/bulk-1.txt",
				"gap4/bulk-1.old.txt",
				"gap4/bulk-2.txt",
				"gap4/bulk-2.old.txt",
				"gap4/bulk-3.txt",
				"gap4/bulk-3.old.txt"
			].sort()
		)
		expect(sha("gap4/keep-local.txt")).toBe(of(localEdit("gap4/keep-local.txt")))
		expect(sha("gap4/keep-cloud.txt")).toBe(of(cloudEdit("gap4/keep-cloud.txt")))
		expect(sha("gap4/bulk-2.txt")).toBe(of(cloudEdit("gap4/bulk-2.txt")))
		expect(sha("gap4/bulk-2.old.txt")).toBe(of(localEdit("gap4/bulk-2.txt")))
		expect(localEdit("gap4/bulk-2.txt").equals(cloudEdit("gap4/bulk-2.txt"))).toBe(false)
	})

	it("matches a bin filed by day under gap4 only, whatever else the bin holds", async () => {
		const bin = tempDir()
		const tree = fixtureTree("previous/e2e-twoway", false)

		seedConflictsCheck(tree)
		writeTree(path.join(bin, "2026-11-03"), {
			files: new Map([
				["gap4/keep-cloud.txt", localEdit("gap4/keep-cloud.txt")],
				...HELD.map((relPath): [string, Buffer] => [relPath, tree.files.get(relPath) ?? Buffer.alloc(0)])
			]),
			emptyDirs: []
		})
		writeFileSync(path.join(bin, ".filed-by-day"), "")
		mkdirSync(path.join(bin, "2026-11-02", "docs"), { recursive: true })
		writeFileSync(path.join(bin, "2026-11-02", "docs", "other.txt"), "other")

		const held = under(await localSnapshot(bin), GAP4_DIR, true)

		expect(diffSnapshots(expectedBin("2026-11-03", "2026-11-03"), held, { identity: false })).toEqual([])
		expect(diffSnapshots(expectedBin("2026-11-02", "2026-11-03"), held, { identity: false })).toContain(
			"missing 2026-11-02/gap4/keep-cloud.txt"
		)
	})

	it("allows the steps' own activity and nothing of the pair's other paths", () => {
		const allowed = conflictsAllowed("e2e-twoway")

		expect(allowed.has("e2e-twoway:deletionsHeld:")).toBe(true)
		expect(allowed.has("e2e-twoway:conflict:gap4/bulk-3.txt")).toBe(true)
		expect(allowed.has("e2e-twoway:binned:gap4/held")).toBe(true)
		expect(allowed.has("e2e-twoway:binned:gap4/held/h30.txt")).toBe(true)
		expect(allowed.has("e2e-twoway:uploaded:gap4/keep-local.txt")).toBe(true)
		expect(allowed.has("e2e-twoway:uploaded:gap4/bulk-1.old.txt")).toBe(true)
		expect(allowed.has("e2e-twoway:uploaded:gap4/keep-cloud.txt")).toBe(false)
		expect(allowed.has("e2e-twoway:downloaded:gap4/keep-local.txt")).toBe(false)
		expect(allowed.has("e2e-twoway:uploaded:docs/notes.txt")).toBe(false)
	})
})

function shell(overrides: Record<string, Partial<ShellPairState>> = {}, extra: ShellPairState[] = []): ShellPairState[] {
	return [
		...LEGACY_PAIRS.map(pair => ({ name: pair.name, pairId: "1", state: "active", review: null, ...overrides[pair.name] })),
		...extra
	]
}

describe("L16 and L17 first-run table", () => {
	it("names the whole-drive pair's file per run, job and chain", () => {
		expect(rootPairFile("filen-desktop-e2e/123-1/deep-mac/L")).toBe("root-local-filen-desktop-e2e-123-1-deep-mac-L.txt")
		expect(rootPairFile("filen-desktop-e2e/123-2/deep-mac/L")).not.toBe(rootPairFile("filen-desktop-e2e/123-1/deep-mac/L"))
		expect(rootPairFile("filen-desktop-e2e/123-1/deep-win/L")).not.toBe(rootPairFile("filen-desktop-e2e/123-1/deep-mac/L"))
	})

	const held = new Set([CLOSED_UPLOAD.pair])
	const refused = new Set([ROOT_PAIR.name])
	const root: ShellPairState = { name: ROOT_PAIR.name, pairId: null, state: "unsupported", review: null, notices: ["refusedWholeDrive"] }

	it("holds e2e-l2c in review for its first-sync deletion", () => {
		expect(LEGACY_FIRST_RUN[CLOSED_UPLOAD.pair]).toMatchObject({
			phase: "review",
			paused: true,
			heldDeletions: 1,
			heldReason: "firstSyncWithDeletions"
		})
		expect(LEGACY_PAIRS.find(pair => pair.name === CLOSED_UPLOAD.pair)?.mode).toBe("localToRemote")
	})

	it("settles once the held pair is in review, the refused one unsupported and the rest active", () => {
		const review = { [CLOSED_UPLOAD.pair]: { state: "review", review: { reason: "migrated" } } }

		expect(firstRunSettled(shell(review, [root]), held, refused)).toBe(true)
		expect(firstRunSettled(shell(), new Set(), new Set())).toBe(true)
		// Still preparing, or the refusal not written yet.
		expect(firstRunSettled(shell({ [CLOSED_UPLOAD.pair]: { state: "preparing" } }, [root]), held, refused)).toBe(false)
		expect(firstRunSettled(shell(review, [{ ...root, state: "preparing", notices: [] }]), held, refused)).toBe(false)
		expect(firstRunSettled(shell(review), held, refused)).toBe(false)
		expect(firstRunSettled(undefined, held, refused)).toBe(false)
		// Without the setup step, a review is unexpected.
		expect(() => firstRunSettled(shell(review), new Set(), new Set())).toThrow(/e2e-l2c waits in review/)
		expect(() => firstRunSettled(shell({ "e2e-c2l": { state: "review" } }, [root]), held, refused)).toThrow(/e2e-c2l waits in review/)
	})

	it("compares a pair's review, phase and pause with the table", () => {
		const want = LEGACY_FIRST_RUN[CLOSED_UPLOAD.pair] ?? null
		const summary = {
			actions: 0,
			uploadBytes: 0,
			downloadBytes: 0,
			heldDeletions: 1,
			heldReason: null,
			conflicts: 0,
			unsyncable: 0,
			ignored: 0,
			refused: null
		}
		const reviewed = {
			phase: "review" as const,
			paused: true,
			review: { reason: "migrated" as const, findings: ["heldDeletions" as const], summary }
		}

		expect(firstRunProblems("e2e-l2c", reviewed, want)).toEqual([])
		expect(firstRunProblems("e2e-l2c", { ...reviewed, paused: false }, want)).toEqual(["e2e-l2c: paused false"])
		expect(firstRunProblems("e2e-l2c", { phase: "idle", paused: false, review: null }, want)).toHaveLength(3)
		expect(firstRunProblems("e2e-c2l", { phase: "idle", paused: false, review: null }, null)).toEqual([])
		expect(firstRunProblems("e2e-c2l", reviewed, null)).toHaveLength(2)
	})

	it("keeps the drive root's entries, refuses the pair's file there and tells other jobs' additions apart", () => {
		const entry = (name: string, id: string, isDir = true): CloudEntry => ({ path: name, isDir, size: 0, modTime: "", id })
		const before = [entry("filen-desktop-e2e", "a"), entry("Documents", "b")]
		const file = rootPairFile("filen-desktop-e2e/123-1/deep-mac/L")

		expect(driveRootChanges(before, [...before, entry("x", "c")], [file])).toEqual({ problems: [], added: ["x"] })
		expect(driveRootChanges(before, [before[0] ?? entry("", ""), entry(file, "d", false)], [file])).toEqual({
			problems: ["Documents gone", `${file} uploaded to the drive root`],
			added: []
		})
		// Only an upload since the listing before N counts: one already there is another run's leftover.
		const leftover = [...before, entry(file, "e", false)]

		expect(driveRootChanges(leftover, leftover, [file])).toEqual({ problems: [], added: [] })
		expect(driveRootChanges(before, [entry("filen-desktop-e2e", "z"), entry("Documents", "b")], []).problems).toEqual([
			"filen-desktop-e2e replaced"
		])
	})

	it("adds the drive-root pair to 3.x's config as its settings do, which 4.x imports paused in local-backup mode", async () => {
		const store = new Map<string, string>()
		const events: string[] = []
		const rootUuid = randomUUID()
		const existing = {
			uuid: randomUUID(),
			name: "e2e-twoway",
			localPath: "/home/e2e/e2e-twoway",
			remoteParentUUID: randomUUID(),
			mode: "twoWay",
			paused: false
		}

		store.set(LEGACY_KEYS.sdkConfig, JSON.stringify({ userId: 42 }))
		store.set(
			LEGACY_KEYS.desktopConfig,
			JSON.stringify({ syncConfig: { enabled: true, syncPairs: [existing] }, webdavConfig: { enabled: false } })
		)
		store.set(LEGACY_KEYS.sync, JSON.stringify({ 7: { enabled: false, syncPairs: [] } }))

		const context = vm.createContext({
			localStorage: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => store.set(key, value)
			},
			window: { dispatchEvent: (event: { key: string }) => events.push(event.key) },
			StorageEvent: class {
				key: string

				constructor(_type: string, init: { key: string }) {
					this.key = init.key
				}
			}
		})
		const page = { evaluate: (source: string) => Promise.resolve(vm.runInContext(source, context) as unknown) } as unknown as Page
		const pair: LegacySyncPair = {
			uuid: randomUUID(),
			name: ROOT_PAIR.name,
			localPath: "/home/e2e/e2e-root",
			remotePath: "/",
			remoteParentUUID: rootUuid,
			mode: "localBackup",
			excludeDotFiles: false,
			paused: true,
			localTrashDisabled: false
		}

		expect(await addLegacyPair(page, pair)).toBe(2)

		const config = JSON.parse(store.get(LEGACY_KEYS.desktopConfig) ?? "null") as { syncConfig: unknown; webdavConfig: unknown }
		const users = JSON.parse(store.get(LEGACY_KEYS.sync) ?? "null") as Record<string, unknown>

		expect(config.webdavConfig).toEqual({ enabled: false })
		expect(users["42"]).toEqual(config.syncConfig)
		expect(users["7"]).toEqual({ enabled: false, syncPairs: [] })
		expect(events.sort()).toEqual([LEGACY_KEYS.desktopConfig, LEGACY_KEYS.sync].sort())

		const imported = legacySyncImport(config.syncConfig)

		expect(imported?.dropped).toBe(0)
		expect(imported?.pairs.find(entry => entry.name === ROOT_PAIR.name)).toMatchObject({
			remoteRoot: rootUuid,
			mode: "localBackup",
			paused: true
		})
	})
})
