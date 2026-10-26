import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	chooseLocalDirectory,
	createRootTokens,
	inspectLocalRoot,
	type LocalRootContext,
	localRootProblem,
	localRootWarnings,
	ROOT_TOKEN_TTL_MS
} from "../main/sync/localRoot.ts"

const OK = { directory: true, writable: true }

const darwin: LocalRootContext = {
	platform: "darwin",
	home: "/Users/u",
	appData: ["/Users/u/Library/Application Support/@filen/desktop", "/Users/u/Library/Application Support"],
	temporary: ["/private/var/folders/ab/xyz/T"],
	pairRoots: ["/Users/u/Work"],
	mountPoints: [],
	oneDrive: []
}

const win32: LocalRootContext = {
	platform: "win32",
	home: "C:\\Users\\u",
	appData: ["C:\\Users\\u\\AppData\\Roaming\\@filen\\desktop", "C:\\Users\\u\\AppData\\Roaming"],
	temporary: ["C:\\Users\\u\\AppData\\Local\\Temp"],
	pairRoots: ["D:\\Sync\\Work"],
	mountPoints: ["X:\\"],
	oneDrive: ["C:\\Users\\u\\OneDrive"]
}

const linux: LocalRootContext = {
	platform: "linux",
	home: "/home/u",
	appData: ["/home/u/.config/@filen/desktop", "/home/u/.config"],
	temporary: ["/tmp"],
	pairRoots: ["/home/u/Work"],
	mountPoints: ["/home/u/Filen"],
	oneDrive: []
}

describe("localRootProblem", () => {
	it("home itself refused, subdirectory allowed", () => {
		expect(localRootProblem("/Users/u", darwin, OK)).toBe("homeDirectory")
		expect(localRootProblem("/Users/u/", darwin, OK)).toBe("homeDirectory")
		expect(localRootProblem("/Users/u/Documents", darwin, OK)).toBeNull()
		expect(localRootProblem("C:\\Users\\U", win32, OK)).toBe("homeDirectory")
		expect(localRootProblem("C:\\Users\\u\\Documents", win32, OK)).toBeNull()
		expect(localRootProblem("/home/u", linux, OK)).toBe("homeDirectory")
		expect(localRootProblem("/home/u/Documents", linux, OK)).toBeNull()
	})

	it("case-insensitive containment on win32 and darwin", () => {
		expect(localRootProblem("/users/U/work/Sub", darwin, OK)).toBe("insidePair")
		expect(localRootProblem("/USERS/u", darwin, OK)).toBe("homeDirectory")
		expect(localRootProblem("d:\\sync", win32, OK)).toBe("containsPair")
		expect(localRootProblem("D:\\SYNC\\WORK", win32, OK)).toBe("insidePair")
		expect(localRootProblem("\\\\?\\D:\\Sync\\Work\\a", win32, OK)).toBe("insidePair")
		expect(localRootProblem("D:\\Sync\\Workshop", win32, OK)).toBeNull()
		// Linux file systems are case-sensitive: a look-alike is another directory.
		expect(localRootProblem("/home/u/work", linux, OK)).toBeNull()
		expect(localRootProblem("/home/u/Work/a", linux, OK)).toBe("insidePair")
		expect(localRootProblem("/home/u/Workshop", linux, OK)).toBeNull()
	})

	it("refuses structural problems", () => {
		expect(localRootProblem("/Users/u/file.txt", darwin, { directory: false, writable: true })).toBe("notDirectory")
		expect(localRootProblem("/Users/u/ro", darwin, { directory: true, writable: false })).toBe("notWritable")
		expect(localRootProblem("/", darwin, OK)).toBe("filesystemRoot")
		expect(localRootProblem("C:\\", win32, OK)).toBe("filesystemRoot")
		expect(localRootProblem("\\\\server\\share\\", win32, OK)).toBe("filesystemRoot")
		expect(localRootProblem("/Users/u/Library/Application Support/@filen/desktop/sync-engine", darwin, OK)).toBe("appData")
		expect(localRootProblem("/Users/u/Library", darwin, OK)).toBe("appData")
		expect(localRootProblem("/home/u/.config/other", linux, OK)).toBe("appData")
		expect(localRootProblem("/private/var/folders/ab/xyz/T/x", darwin, OK)).toBe("temporary")
		expect(localRootProblem("/private/var", darwin, OK)).toBe("temporary")
		expect(localRootProblem("/tmp/x", linux, OK)).toBe("temporary")
		expect(localRootProblem("/home/u/Work", linux, OK)).toBe("insidePair")
		expect(localRootProblem("/home/u/Filen/a", linux, OK)).toBe("insideMount")
		expect(localRootProblem("X:\\a", win32, OK)).toBe("insideMount")
		expect(localRootProblem("/home/u/Documents", { ...linux, mountPoints: ["/home/u/Documents/Filen"] }, OK)).toBe("containsMount")
	})
})

describe("localRootWarnings", () => {
	it("iCloud and CloudStorage only warn on darwin", () => {
		expect(localRootWarnings("/Users/u/Library/Mobile Documents/com~apple~CloudDocs/Work", darwin)).toEqual(["iCloud"])
		expect(localRootWarnings("/Users/u/Library/CloudStorage/GoogleDrive-a@b.c/My Drive", darwin)).toEqual(["cloudStorage"])
		expect(localRootWarnings("/Users/u/Library/CloudStorage/OneDrive-Personal", darwin)).toEqual(["oneDrive"])
		expect(localRootWarnings("/Users/u/Documents", darwin)).toEqual([])
		expect(localRootWarnings("/home/u/Library/Mobile Documents/x", { ...linux, home: "/home/u" })).toEqual([])
		expect(localRootWarnings("/home/u/Library/CloudStorage/x", linux)).toEqual([])
		expect(localRootWarnings("C:\\Users\\u\\Library\\CloudStorage\\x", { ...win32, oneDrive: [] })).toEqual([])
		expect(localRootWarnings("c:\\users\\u\\onedrive\\Work", win32)).toEqual(["oneDrive"])
	})

	it("only warns, never refuses", () => {
		expect(localRootProblem("/Users/u/Library/Mobile Documents/com~apple~CloudDocs/Work", darwin, OK)).toBeNull()
		expect(localRootProblem("C:\\Users\\u\\OneDrive\\Work", win32, OK)).toBeNull()
	})
})

describe("createRootTokens", () => {
	it("token expires and is single use", () => {
		let now = 1_000
		const tokens = createRootTokens(() => now)
		const first = tokens.issue("/Users/u/A")
		const second = tokens.issue("/Users/u/B")

		expect(first).toMatch(/^[0-9a-f]{32}$/)
		expect(first).not.toBe(second)
		expect(tokens.take(first)).toBe("/Users/u/A")
		expect(tokens.take(first)).toBeNull()
		expect(tokens.take("unknown")).toBeNull()

		now += ROOT_TOKEN_TTL_MS
		expect(tokens.take(second)).toBeNull()

		const third = tokens.issue("/Users/u/C")

		now += ROOT_TOKEN_TTL_MS - 1
		expect(tokens.take(third)).toBe("/Users/u/C")
	})
})

describe("chooseLocalDirectory", () => {
	let dir: string
	let ctx: LocalRootContext

	beforeEach(async () => {
		dir = await realpath(await mkdtemp(path.join(tmpdir(), "filen-local-root-")))
		ctx = {
			platform: process.platform,
			home: path.join(dir, "home"),
			appData: [],
			temporary: [],
			pairRoots: [],
			mountPoints: [],
			oneDrive: []
		}
		await mkdir(path.join(dir, "home", "Docs"), { recursive: true })
		await writeFile(path.join(dir, "file.txt"), "x")
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("issues a token for an allowed directory and refuses the rest", async () => {
		const tokens = createRootTokens(() => 0)
		const dialog = (filePaths: string[], canceled = false) => vi.fn(() => Promise.resolve({ canceled, filePaths }))
		const docs = path.join(dir, "home", "Docs")
		const choice = await chooseLocalDirectory(dialog([docs]), () => ctx, tokens)

		expect(choice).toEqual({
			status: "ok",
			id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
			path: docs,
			name: "Docs",
			warnings: []
		})
		expect(choice.status === "ok" ? tokens.take(choice.id) : null).toBe(docs)
		expect(await chooseLocalDirectory(dialog([path.join(dir, "home")]), () => ctx, tokens)).toEqual({
			status: "refused",
			path: path.join(dir, "home"),
			problem: "homeDirectory"
		})
		expect(await chooseLocalDirectory(dialog([path.join(dir, "file.txt")]), () => ctx, tokens)).toMatchObject({
			problem: "notDirectory"
		})
		expect(await chooseLocalDirectory(dialog([], true), () => ctx, tokens)).toEqual({ status: "canceled" })
	})

	it("re-checks a path that has gone", async () => {
		expect(await inspectLocalRoot(path.join(dir, "missing"), ctx)).toEqual({
			path: path.join(dir, "missing"),
			problem: "notDirectory",
			warnings: []
		})
	})
})
