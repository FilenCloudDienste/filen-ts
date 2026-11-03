import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Chain } from "../../scripts/ci/e2e/chains/common.ts"
import { realWorldFor, renameProblems } from "../../scripts/ci/e2e/chains/realWorld.ts"
import { type Cloud, type CloudEntry, excludeArgs, prefixFilterArgs } from "../../scripts/ci/e2e/cloud.ts"
import {
	expectedCloudReasons,
	expectedUnsyncable,
	NAME_FIXTURES,
	namesFor,
	NAMES_PAIR,
	NAMES_RENAMES
} from "../../scripts/ci/e2e/fixtures.ts"
import { createFindings, type Finding } from "../../scripts/ci/e2e/findings.ts"
import {
	currentScale,
	FIXTURES_ROOT,
	layoutSnapshot,
	manifestOf,
	readManifest,
	SCALE_DIRS,
	SCALE_FILES,
	SCALE_MANIFEST_NAME,
	scaleGeneration,
	scaleLayout,
	scaleTree,
	staleGenerations
} from "../../scripts/ci/e2e/scaleTree.ts"
import { cloudSnapshot, diffSnapshots, localSnapshot } from "../../scripts/ci/e2e/snapshot.ts"

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-realworld-"))

	dirs.push(dir)

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

function entry(relPath: string, isDir: boolean, size: number, id: string): CloudEntry {
	return { path: relPath, isDir, size, modTime: "2026-11-03T00:00:00Z", id }
}

// A cloud that lists `entries` and records what a download leaves out.
function listingCloud(entries: CloudEntry[]): { cloud: Cloud; downloads: (readonly string[] | undefined)[] } {
	const downloads: (readonly string[] | undefined)[] = []
	const unused = () => Promise.reject(new Error("not used"))
	const cloud: Cloud = {
		mkdir: unused,
		upload: unused,
		uploadFile: unused,
		list: () => Promise.resolve(entries),
		dirId: unused,
		download: (_dir, _local, exclude) => {
			downloads.push(exclude)

			return Promise.resolve()
		},
		purge: unused,
		purgeFiles: unused,
		emptyTrash: unused,
		about: unused,
		cat: unused,
		sha256Of: unused,
		moveto: unused
	}

	return { cloud, downloads }
}

describe("e2e scale tree", () => {
	it("is 8,200 files in 300 directories three levels deep, one in twenty empty, none over 4 KiB, the same every time", () => {
		const layout = scaleLayout()

		expect(layout.dirs).toHaveLength(SCALE_DIRS)
		expect(SCALE_DIRS).toBe(300)
		expect(layout.files).toHaveLength(SCALE_FILES)
		expect(new Set(layout.dirs.map(dir => dir.split("/").length))).toEqual(new Set([1, 2, 3]))
		expect(layout.files.filter(file => file.size === 0)).toHaveLength(SCALE_FILES / 20)
		expect(Math.max(...layout.files.map(file => file.size))).toBeLessThanOrEqual(4096)
		expect(new Set(layout.files.map(file => file.path)).size).toBe(SCALE_FILES)
		expect(layoutSnapshot(layout).size).toBe(8500)
		expect(scaleLayout()).toEqual(layout)

		const tree = scaleTree(layout)

		expect(tree.files.get(layout.files[1]?.path ?? "")).toEqual(scaleTree().files.get(layout.files[1]?.path ?? ""))
		expect([...tree.files.values()].reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThan(20 * 1024 * 1024)
	})

	it("reads its manifest back as the generation and list-only snapshot it was written from, and refuses a malformed one", () => {
		const entries = [entry("a0", true, 0, "dir-uuid"), entry("a0/f0001.txt", false, 12, "file-uuid")]
		const generation = scaleGeneration(new Date("2026-11-03T01:23:45.678Z"))
		const current = readManifest(JSON.stringify(manifestOf(generation, entries)))

		expect(generation).toBe("scale-v1.2026-11-03T01-23-45-678Z")
		expect(manifestOf(generation, entries).entries).toEqual(["a0/:0:dir-uuid", "a0/f0001.txt:12:file-uuid"])
		expect(current.dir).toBe(`${FIXTURES_ROOT}/${generation}`)
		expect([...current.snapshot]).toEqual([
			["a0", { kind: "dir", size: 0, sha256: null, identity: "dir-uuid" }],
			["a0/f0001.txt", { kind: "file", size: 12, sha256: null, identity: "file-uuid" }]
		])
		expect(() => readManifest(JSON.stringify({ version: 2, dir: generation, entries: ["no-size"] }))).toThrow(/path:size:uuid/)
		expect(() => readManifest(JSON.stringify({ version: 1, entries: [] }))).toThrow(/version 2/)

		for (const dir of ["scale-v1", "other", "scale-v1.x/../y", SCALE_MANIFEST_NAME]) {
			expect(() => readManifest(JSON.stringify({ version: 2, dir, entries: [] }))).toThrow(/generation/)
		}
	})

	it("is unseeded without a manifest, which is not an error", async () => {
		const { cloud } = listingCloud([entry("scale-v1.2026-11-03T00-00-00-000Z", true, 0, "g")])

		await expect(currentScale(cloud)).resolves.toBeNull()
		await expect(currentScale({ ...cloud, list: () => Promise.resolve(null) })).resolves.toBeNull()
	})

	it("removes on a reseed every generation but its own and the one runs may still be pulling", () => {
		const siblings = [
			entry("scale-v1.a", true, 0, "1"),
			entry("scale-v1.b", true, 0, "2"),
			entry("scale-v1.c", true, 0, "3"),
			entry(SCALE_MANIFEST_NAME, false, 10, "m"),
			entry("other", true, 0, "o")
		]

		expect(staleGenerations(siblings, ["scale-v1.c", "scale-v1.b"])).toEqual(["scale-v1.a"])
		expect(staleGenerations(siblings, ["scale-v1.c"])).toEqual(["scale-v1.a", "scale-v1.b"])
	})

	it("tells a rewritten or resized entry from the manifest by its listing alone", async () => {
		const entries = [entry("a0", true, 0, "d"), entry("a0/f.txt", false, 12, "u1")]
		const manifest = readManifest(JSON.stringify(manifestOf(scaleGeneration(new Date(0)), entries))).snapshot
		const { cloud, downloads } = listingCloud([entry("a0", true, 0, "d"), entry("a0/f.txt", false, 12, "u2")])
		const listed = await cloudSnapshot(cloud, "x", tempDir(), { listOnly: true })

		expect(downloads).toEqual([])
		expect(diffSnapshots(manifest, listed ?? new Map(), { identity: true })).toEqual(["a0/f.txt: rewritten (identity changed)"])
	})
})

describe("e2e cloud snapshot options", () => {
	it("leaves excluded paths out of the listing and the download", async () => {
		const { cloud, downloads } = listingCloud([
			entry("keep.txt", false, 0, "k"),
			entry(NAMES_PAIR, true, 0, "n"),
			entry(`${NAMES_PAIR}/CON`, false, 3, "c")
		])
		const snapshot = await cloudSnapshot(cloud, "x", tempDir(), { exclude: [NAMES_PAIR] })

		expect([...(snapshot?.keys() ?? [])]).toEqual(["keep.txt"])
		expect(downloads).toEqual([[NAMES_PAIR]])
	})

	it("turns excluded paths into rclone filter rules, glob characters escaped", () => {
		expect(excludeArgs(["e2e-names", "a[1]*"])).toEqual([
			"--exclude",
			"/e2e-names",
			"--exclude",
			"/e2e-names/**",
			"--exclude",
			"/a\\[1\\]\\*",
			"--exclude",
			"/a\\[1\\]\\*/**"
		])
	})

	it("purges by a name prefix in the directory itself only, glob characters escaped", () => {
		expect(prefixFilterArgs("locked-")).toEqual(["--max-depth", "1", "--include", "/locked-*"])
		expect(prefixFilterArgs("a[1]*")).toEqual(["--max-depth", "1", "--include", "/a\\[1\\]\\**"])
	})

	it("keeps an NFD name as spelled in a raw local snapshot only", async () => {
		const root = tempDir()

		writeFileSync(path.join(root, "café.txt"), "x")

		expect([...(await localSnapshot(root)).keys()]).toEqual(["café.txt"])
		expect([...(await localSnapshot(root, { raw: true })).keys()]).toEqual(["café.txt"])
	})
})

describe("e2e names pair", () => {
	it("expects of each OS what sdk-rs's device check and name validator make of it", () => {
		expect(expectedUnsyncable("win")).toEqual(
			["aux.c", "CON", "Q&A: what?.txt", "trailing dot.", "bad:dir", "alias-dir", `${"文件名".repeat(32)}.txt`].sort()
		)
		expect(expectedUnsyncable("mac")).toEqual(["Folder ", "Invoice 1:2.pdf", "alias-dir"].sort())
		expect(expectedUnsyncable("linux")).toEqual(["Data.txt", "What?.txt", "alias-dir", "data.txt"].sort())
		expect(expectedCloudReasons("win")).toEqual(
			new Map(["aux.c", "CON", "Q&A: what?.txt", "trailing dot.", "bad:dir"].map(relPath => [relPath, "remoteNameNotStorable"]))
		)
		expect(expectedCloudReasons("mac").size).toBe(0)
		expect(expectedCloudReasons("linux").size).toBe(0)
		// Every OS syncs the NFD names both ways and ignores the built-in set.
		for (const os of ["linux", "win", "mac"] as const) {
			const fixtures = namesFor(os)

			expect(fixtures.filter(fixture => fixture.path.normalize("NFC") !== fixture.path).map(fixture => fixture.expect)).toEqual([
				"synced",
				"synced",
				"synced"
			])
			expect(fixtures.filter(fixture => fixture.expect === "ignored")).toHaveLength(20)
		}
	})

	it("takes PN5's case renames only as one cloud item each, spelled as renamed, with the uuid it had", () => {
		const file = (relPath: string, id: string): CloudEntry => ({ path: relPath, isDir: false, size: 1, modTime: "", id })
		const ids = { local: "uuid-report", cloud: "uuid-notes" }
		const renamed = [file("report.txt", "uuid-report"), file("notes.md", "uuid-notes"), file("other.txt", "uuid-other")]

		expect(renameProblems(renamed, ["report.txt", "notes.md"], ids)).toEqual([])
		expect(renameProblems([file("report.txt", "uuid-new"), file("notes.md", "uuid-notes")], ["notes.md"], ids)).toEqual([
			'"report.txt" has uuid uuid-new, not uuid-report: deleted and uploaded anew, not renamed'
		])
		expect(
			renameProblems(
				[file("Report.txt", "uuid-report"), file("report.txt", "uuid-new"), file("notes.md", "uuid-notes")],
				["notes.md"],
				ids
			)
		).toEqual(['cloud ["Report.txt","report.txt"], expected ["report.txt"]'])
		expect(renameProblems([file("report.txt", "uuid-report"), file("Notes.md", "uuid-notes")], ["Notes.md"], ids)).toEqual([
			'cloud ["Notes.md"], expected ["notes.md"]',
			'on disk ["Notes.md"], expected ["notes.md"]'
		])
	})

	it("holds names at the limits it is meant to", () => {
		const local = (pathOf: (relPath: string) => boolean) => NAME_FIXTURES.find(fixture => pathOf(fixture.path))?.path ?? ""
		const longName = local(relPath => /^n+\.txt$/.test(relPath))
		const cjk = local(relPath => relPath.startsWith("文件名"))
		const deepLocal = local(relPath => relPath.startsWith("deep-0-"))
		const deepCloud = local(relPath => relPath.startsWith("long-dir-0-"))

		expect(Buffer.byteLength(longName)).toBe(255)
		expect(cjk.length).toBe(100)
		expect(Buffer.byteLength(cjk)).toBeGreaterThan(255)
		expect(deepLocal.length).toBe(300)
		expect(
			deepCloud
				.split("/")
				.slice(0, -1)
				.map(dir => dir.length)
		).toEqual([45, 45, 45, 45, 45, 45])
		expect(deepCloud.split("/").at(-1)?.length).toBe(200)
		expect(NAME_FIXTURES.filter(fixture => fixture.path === NAMES_RENAMES.edit.path)[0]?.side).toBe("cloud")
		expect(NAME_FIXTURES.filter(fixture => fixture.path === NAMES_RENAMES.cloud.from)[0]?.side).toBe("cloud")
		expect(NAME_FIXTURES.filter(fixture => fixture.path === NAMES_RENAMES.local.from)[0]?.side).toBe("local")
	})

	it("runs on three entries only, the names pair only when asked", () => {
		const chainOn = (platform: string, format: string) => {
			const partial = { findings: {}, cloud: {}, target: { platform, format }, cloudDir: "run/entry/previous" }

			return partial as unknown as Chain
		}

		vi.stubEnv("E2E_NAMES_CHECK", "")
		expect(realWorldFor(chainOn("linux", "deb"), "x64").cloudExclude).toEqual([])

		vi.stubEnv("E2E_NAMES_CHECK", "1")
		expect(realWorldFor(chainOn("linux", "deb"), "x64").cloudExclude).toEqual([NAMES_PAIR])
		expect(realWorldFor(chainOn("win", "nsis"), "x64").cloudExclude).toEqual([NAMES_PAIR])
		expect(realWorldFor(chainOn("mac", "dmg"), "arm64").cloudExclude).toEqual([NAMES_PAIR])
		expect(realWorldFor(chainOn("linux", "deb"), "arm64").cloudExclude).toEqual([])
		expect(realWorldFor(chainOn("linux", "AppImage"), "x64").cloudExclude).toEqual([])
	})
})

describe("e2e scale pair", () => {
	// Chain P on linux-x64-deb with a page that answers the sync contract: the pair added, then idle at once, its
	// root left empty (so PS2 fails), gone from the overview once removed. Records the contract calls.
	const scaleChain = (cloud: Cloud) => {
		const work = tempDir()
		const artifacts = path.join(work, "artifacts")
		const findings = createFindings("test", artifacts)
		const calls: string[] = []
		const answer = (expression: string): unknown => {
			if (expression.includes("chooseLocalDirectory")) {
				return { status: "ok", id: "root", path: path.join(work, "e2e-scale") }
			}

			if (expression.includes("addPair")) {
				return { ok: true, value: { pairId: "scale-id", plan: null } }
			}

			if (expression.includes("overview")) {
				return {
					pairs: calls.some(call => call.includes("removePair"))
						? []
						: [{ id: "scale-id", phase: "idle", lastSyncedAt: 1, lastError: null, issues: 0, review: null }]
				}
			}

			return { ok: true, value: null }
		}
		const page = {
			evaluate: (code: string) => {
				calls.push(code)

				return Promise.resolve(JSON.stringify({ value: answer(code) }))
			}
		}
		const partial = {
			name: "previous",
			findings,
			cloud,
			target: { platform: "linux", format: "deb" },
			cloudDir: "run/entry/previous",
			work,
			artifacts,
			page: () => page,
			os: { chooseDirectory: () => Promise.resolve(), screenDump: () => Promise.resolve() },
			rootOf: (name: string) => path.join(work, name),
			syncOverview: () => Promise.resolve(answer("overview")),
			snapshotOf: (name: string) => localSnapshot(path.join(work, name))
		}

		return { chain: partial as unknown as Chain, artifacts, findings, calls }
	}
	const recorded = (artifacts: string): Finding[] =>
		JSON.parse(readFileSync(path.join(artifacts, "test-findings.json"), "utf8")) as Finding[]

	it("stays off with a note while the tree is unseeded", async () => {
		vi.stubEnv("E2E_NAMES_CHECK", "")

		const { cloud } = listingCloud([])
		const { chain, artifacts, findings, calls } = scaleChain(cloud)

		await realWorldFor(chain, "x64").setUp()
		findings.finish()

		expect(calls).toEqual([])
		expect(recorded(artifacts).map(finding => [finding.check, finding.ok, finding.info])).toEqual([
			["PS0 the scale tree's manifest names its current generation", true, false],
			["PS scale pair", true, true],
			["PN names pair", true, true]
		])
	})

	it("removes the pair at once when the pulled tree is wrong, so the update and N run without it", async () => {
		vi.stubEnv("E2E_NAMES_CHECK", "")

		const generation = scaleGeneration(new Date(0))
		const manifest = Buffer.from(JSON.stringify(manifestOf(generation, [])))
		const { cloud } = listingCloud([entry(SCALE_MANIFEST_NAME, false, manifest.length, "m")])
		const { chain, artifacts, findings, calls } = scaleChain({
			...cloud,
			cat: () => Promise.resolve(manifest),
			dirId: dir => Promise.resolve(dir === `${FIXTURES_ROOT}/${generation}` ? "generation-uuid" : "wrong")
		})
		const realWorld = realWorldFor(chain, "x64")

		await realWorld.setUp()

		const removals = () => calls.filter(call => call.includes("removePair"))

		expect(removals()).toHaveLength(1)
		expect(calls.some(call => call.includes('"remoteRoot":"generation-uuid"'))).toBe(true)

		await realWorld.afterUpdate()
		await realWorld.onN()

		expect(() => {
			findings.finish()
		}).toThrow(/1 check\(s\) failed: PS2/)

		expect(removals()).toHaveLength(1)
		expect(recorded(artifacts).map(finding => [finding.check.split(" (")[0], finding.ok])).toEqual([
			["PS0 the scale tree's manifest names its current generation", true],
			["PS1 the scale pull's time to idle on N-1", true],
			["PS1 e2e-scale", true],
			["PS2 the pulled tree is the generated tree byte for byte", false],
			["the scale pair removed at once after PS1 or PS2 failed", true],
			["PN names pair", true]
		])
	})
})
