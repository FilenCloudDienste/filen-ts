import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	chooseMountPoint,
	configuredMountPoints,
	defaultMountPoint,
	inspectMountPoint,
	type MountPointContext,
	mountPointProblem,
	validDriveLetter
} from "../main/mounts/mountPoint.ts"
import { DEFAULT_MOUNTS } from "../main/mounts/store.ts"
import { createRootTokens } from "../main/sync/localRoot.ts"

const OK = { directory: true, symlink: false, empty: true }

const darwin: MountPointContext = {
	platform: "darwin",
	home: "/Users/u",
	appData: ["/Users/u/Library/Application Support/@filen/desktop", "/Users/u/Library/Application Support"],
	temporary: ["/private/var/folders/ab/xyz/T", "/private/tmp"],
	pairRoots: ["/Users/u/Work"]
}

const linux: MountPointContext = {
	platform: "linux",
	home: "/home/u",
	appData: ["/home/u/.config/@filen/desktop", "/home/u/.config"],
	temporary: ["/tmp"],
	pairRoots: ["/home/u/Sync"]
}

describe("mountPointProblem", () => {
	it("allows an empty directory of the user's own", () => {
		expect(mountPointProblem("/Users/u/Filen", darwin, OK)).toBeNull()
		expect(mountPointProblem("/home/u/Cloud/Filen", linux, OK)).toBeNull()
	})

	it("/tmp/filen refused", () => {
		expect(mountPointProblem("/private/tmp/filen", darwin, OK)).toBe("temporary")
		expect(mountPointProblem("/tmp/filen", linux, OK)).toBe("temporary")
		expect(mountPointProblem("/mnt/filen", linux, OK)).toBe("outsideHome")
	})

	it("home itself refused", () => {
		expect(mountPointProblem("/Users/U", darwin, OK)).toBe("homeDirectory")
		expect(mountPointProblem("/home/u", linux, OK)).toBe("homeDirectory")
		expect(mountPointProblem("/Users/u/Library/Application Support/Filen", darwin, OK)).toBe("appData")
	})

	it("non-empty refused", () => {
		expect(mountPointProblem("/Users/u/Filen", darwin, { ...OK, empty: false })).toBe("notEmpty")
		expect(mountPointProblem("/Users/u/Filen", darwin, { ...OK, directory: false })).toBe("notDirectory")
		expect(mountPointProblem("/Users/u/Filen", darwin, { ...OK, symlink: true })).toBe("symlink")
	})

	it("pair overlap refused both ways", () => {
		expect(mountPointProblem("/Users/u/Work/Filen", darwin, OK)).toBe("insidePair")
		expect(mountPointProblem("/Users/u/work", darwin, OK)).toBe("insidePair")
		expect(mountPointProblem("/home/u/Cloud", { ...linux, pairRoots: ["/home/u/Cloud/Sync"] }, OK)).toBe("containsPair")
		// Case-sensitive on Linux.
		expect(mountPointProblem("/home/u/sync", linux, OK)).toBeNull()
	})
})

describe("drive letters", () => {
	it("drive letter outside D-Z rejected", () => {
		const available = ["C", "D", "X", "Z"]

		expect(validDriveLetter("X", available)).toBe(true)
		expect(validDriveLetter("D", available)).toBe(true)
		expect(validDriveLetter("C", available)).toBe(false)
		expect(validDriveLetter("x", available)).toBe(false)
		expect(validDriveLetter("X:", available)).toBe(false)
		expect(validDriveLetter("Y", available)).toBe(false)
		expect(validDriveLetter(7, available)).toBe(false)
	})

	it("defaults to X, else the next free letter down", () => {
		expect(defaultMountPoint("C:\\Users\\u", "win32", ["D", "E", "X"])).toBe("X")
		expect(defaultMountPoint("C:\\Users\\u", "win32", ["D", "E"])).toBe("E")
		expect(defaultMountPoint("C:\\Users\\u", "win32", ["A", "C"])).toBeNull()
		expect(defaultMountPoint("/Users/u", "darwin", [])).toBe("/Users/u/Filen")
	})

	it("configured mount points for the sync guard", () => {
		const drive = { ...DEFAULT_MOUNTS.drive, mountPoint: "/Users/u/Filen", driveLetter: "X" }

		expect(configuredMountPoints({ ...DEFAULT_MOUNTS, drive }, "darwin")).toEqual(["/Users/u/Filen"])
		expect(configuredMountPoints({ ...DEFAULT_MOUNTS, drive }, "win32")).toEqual(["X:\\"])
		expect(configuredMountPoints(DEFAULT_MOUNTS, "linux")).toEqual([])
	})
})

describe.skipIf(process.platform === "win32")("chooseMountPoint", () => {
	let dir: string
	let ctx: MountPointContext

	beforeEach(async () => {
		dir = await realpath(await mkdtemp(path.join(tmpdir(), "filen-mount-point-")))
		ctx = { platform: process.platform, home: path.join(dir, "home"), appData: [], temporary: [], pairRoots: [] }
		await mkdir(path.join(dir, "home", "Filen"), { recursive: true })
		await mkdir(path.join(dir, "home", "Full"), { recursive: true })
		await writeFile(path.join(dir, "home", "Full", "a.txt"), "x")
		await symlink(path.join(dir, "home", "Filen"), path.join(dir, "home", "Link"))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("issues a token for an allowed directory and refuses the rest", async () => {
		const tokens = createRootTokens(() => 0)
		const dialog = (filePaths: string[], canceled = false) => vi.fn(() => Promise.resolve({ canceled, filePaths }))
		const filen = path.join(dir, "home", "Filen")
		const choice = await chooseMountPoint(dialog([filen]), () => ctx, tokens)

		expect(choice).toEqual({ status: "ok", id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown, path: filen })
		expect(await chooseMountPoint(dialog([path.join(dir, "home", "Full")]), () => ctx, tokens)).toMatchObject({ problem: "notEmpty" })
		expect(await chooseMountPoint(dialog([path.join(dir, "home", "Link")]), () => ctx, tokens)).toMatchObject({ problem: "symlink" })
		expect(await chooseMountPoint(dialog([path.join(dir, "home", "Full", "a.txt")]), () => ctx, tokens)).toMatchObject({
			problem: "notDirectory"
		})
		expect(await chooseMountPoint(dialog([], true), () => ctx, tokens)).toEqual({ status: "canceled" })
	})

	it("token single use", async () => {
		const tokens = createRootTokens(() => 0)
		const choice = await chooseMountPoint(
			() => Promise.resolve({ canceled: false, filePaths: [path.join(dir, "home", "Filen")] }),
			() => ctx,
			tokens
		)
		const id = choice.status === "ok" ? choice.id : ""

		expect(tokens.take(id)).toBe(path.join(dir, "home", "Filen"))
		expect(tokens.take(id)).toBeNull()
	})

	it("re-checks a path that has gone", async () => {
		expect(await inspectMountPoint(path.join(dir, "missing"), ctx)).toEqual({
			path: path.join(dir, "missing"),
			problem: "notDirectory"
		})
	})
})
