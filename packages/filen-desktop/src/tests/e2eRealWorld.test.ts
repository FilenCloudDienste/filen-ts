import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Chain } from "../../scripts/ci/e2e/chains/common.ts"
import { realWorldFor } from "../../scripts/ci/e2e/chains/realWorld.ts"
import { type Cloud, type CloudEntry, excludeArgs } from "../../scripts/ci/e2e/cloud.ts"
import { expectedUnsyncable, NAME_FIXTURES, namesFor, NAMES_PAIR, NAMES_RENAMES } from "../../scripts/ci/e2e/fixtures.ts"
import {
	layoutSnapshot,
	manifestOf,
	manifestSnapshot,
	SCALE_DIRS,
	SCALE_FILES,
	scaleLayout,
	scaleTree
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

	it("reads its manifest back as the list-only snapshot it was written from, and refuses a malformed one", () => {
		const entries = [entry("a0", true, 0, "dir-uuid"), entry("a0/f0001.txt", false, 12, "file-uuid")]
		const snapshot = manifestSnapshot(JSON.stringify(manifestOf(entries)))

		expect(manifestOf(entries).entries).toEqual(["a0/:0:dir-uuid", "a0/f0001.txt:12:file-uuid"])
		expect([...snapshot]).toEqual([
			["a0", { kind: "dir", size: 0, sha256: null, identity: "dir-uuid" }],
			["a0/f0001.txt", { kind: "file", size: 12, sha256: null, identity: "file-uuid" }]
		])
		expect(() => manifestSnapshot(JSON.stringify({ version: 1, entries: ["no-size"] }))).toThrow(/path:size:uuid/)
		expect(() => manifestSnapshot(JSON.stringify({ version: 2, entries: [] }))).toThrow(/version 1/)
	})

	it("tells a rewritten or resized entry from the manifest by its listing alone", async () => {
		const entries = [entry("a0", true, 0, "d"), entry("a0/f.txt", false, 12, "u1")]
		const manifest = manifestSnapshot(JSON.stringify(manifestOf(entries)))
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
