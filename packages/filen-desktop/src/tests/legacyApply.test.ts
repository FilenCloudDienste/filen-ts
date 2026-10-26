import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LegacyFeature } from "../main/legacyData.ts"
import { createCredentialStore } from "../main/mounts/credentials.ts"
import { createLegacyMounts, holdsFiles, type LegacyMountsDeps } from "../main/mounts/legacyApply.ts"
import { DEFAULT_MOUNTS, defaultServe, loadMountsStore, type MountsConfig, type MountsStore } from "../main/mounts/store.ts"
import type { MountsOp, NativeOpArgs, NativeOpResult } from "../shared/nativeProtocol.ts"
import { fakeCipher, memoryFile } from "./fileFakes.ts"

const BINARY = { path: "/opt/filen/rclone", sha256: null }
const STRONG_WEBDAV = { enabled: true, username: "filen-user-01", password: "a-strong-passphrase-42", hostname: "127.0.0.1", port: 1900 }

type Answers = { [K in "quiesceLegacy" | "drainCache"]?: (args: NativeOpArgs<K>) => NativeOpResult<K> | { refuse: "timeout" } }

let directory: string

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-legacy-mounts-")))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

async function put(relative: string, content = "data"): Promise<string> {
	const file = path.join(directory, relative)

	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, content)

	return file
}

function exists(relative: string): Promise<boolean> {
	return stat(path.join(directory, relative)).then(
		() => true,
		() => false
	)
}

async function stage(): Promise<unknown> {
	return JSON.parse(await readFile(path.join(directory, "mounts", "legacy.json"), "utf8")).stage
}

function oldDrive(enabled = true) {
	return { enabled, mountPoint: path.join(directory, "home", "Filen"), readOnly: false, cacheSizeInGi: 10 }
}

interface Shared {
	stash: Record<string, Partial<Record<LegacyFeature, unknown>>>
	stores: Map<string, Promise<MountsStore>>
	configs: Map<string, MountsConfig>
}

function shared(stash: Shared["stash"] = {}, configs: Record<string, MountsConfig> = {}): Shared {
	return { stash, stores: new Map(), configs: new Map(Object.entries(configs)) }
}

// One app run against `directory` as userData; `state` outlives it, as the files do across a crash.
function setup(
	state: Shared,
	options: { owner?: string | null | undefined; answers?: Answers; binary?: boolean; consumeFails?: boolean } = {}
) {
	const answers: Answers = {
		quiesceLegacy: () => ({ stopped: 1, unmounted: [] }),
		drainCache: () => ({ pending: 0, errored: 0 }),
		...options.answers
	}
	const call = vi.fn((op: MountsOp, args: unknown) => {
		const answer = (answers as Partial<Record<MountsOp, (args: unknown) => unknown>>)[op]
		const value = answer === undefined ? { refuse: "unknown" } : answer(args)

		return Promise.resolve(
			typeof value === "object" && value !== null && "refuse" in value
				? { ok: false, error: { code: value.refuse } }
				: { ok: true, value }
		)
	})
	const credentials = createCredentialStore(memoryFile(), () => Promise.resolve(fakeCipher()), vi.fn())
	const consume = vi.fn((userId: string, feature: LegacyFeature) => {
		if (options.consumeFails === true) {
			return Promise.reject(new Error("locked"))
		}

		delete state.stash[userId]?.[feature]

		return Promise.resolve()
	})
	const warn = vi.fn()
	const storeFor = (userId: string) => {
		let store = state.stores.get(userId)

		if (store === undefined) {
			const config = state.configs.get(userId)

			store = loadMountsStore(memoryFile(config === undefined ? null : Buffer.from(JSON.stringify(config))), vi.fn())
			state.stores.set(userId, store)
		}

		return store
	}
	const deps: LegacyMountsDeps = {
		userData: directory,
		mountsDir: userId => path.join(directory, "mounts", userId),
		owner: () => Promise.resolve("owner" in options ? options.owner : "1"),
		binary: options.binary === false ? null : BINARY,
		platform: "linux",
		call: call as unknown as LegacyMountsDeps["call"],
		stash: { pending: (userId, feature) => Promise.resolve(state.stash[userId]?.[feature]), consume },
		storeFor,
		credentialsFor: () => credentials,
		mountPointContext: () =>
			Promise.resolve({ platform: "linux", home: path.join(directory, "home"), appData: [], temporary: [], pairRoots: [] }),
		log: { info: vi.fn(), warn }
	}

	return {
		legacy: createLegacyMounts(deps),
		call,
		consume,
		credentials,
		warn,
		store: async (userId = "1") => (await storeFor(userId)).get(),
		ops: () => call.mock.calls.map(([op]) => op),
		argsOf: (op: MountsOp) => call.mock.calls.filter(([name]) => name === op).map(([, args]) => args)
	}
}

describe("holdsFiles", () => {
	it("an empty cache tree holds none", async () => {
		await mkdir(path.join(directory, "cache", "vfs", "Filen"), { recursive: true })
		expect(await holdsFiles(path.join(directory, "cache"))).toBe(false)
		expect(await holdsFiles(path.join(directory, "missing"))).toBe(false)
		await put("cache/vfsMeta/Filen/a.txt")
		expect(await holdsFiles(path.join(directory, "cache"))).toBe(true)
	})
})

describe("createLegacyMounts", () => {
	it("old cache adopted, never deleted with pending uploads", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")
		await put("networkDrive/cache/vfsMeta/Filen/a.txt")
		await put("rclone/bin/1.74.3/rclone")
		await put("rclone/tls/cert.pem")
		await put("rclone/monitor.v3.drive.sh")
		await mkdir(path.join(directory, "home", "Filen"), { recursive: true })

		const state = shared({ "1": { networkDrive: oldDrive() } })
		const run = setup(state)

		expect(await run.legacy.wanted("1")).toBe(true)
		await run.legacy.prepare("1")

		expect(run.argsOf("quiesceLegacy")).toEqual([
			{ binDir: path.join(directory, "rclone", "bin"), mountPoints: [path.join(directory, "home", "Filen")] }
		])
		expect(await exists("mounts/1/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await exists("networkDrive/cache")).toBe(false)
		expect(await exists("rclone")).toBe(false)
		expect((await run.store()).drive).toMatchObject({ enabled: true, mountPoint: path.join(directory, "home", "Filen") })
		expect((await run.store()).legacyApplied).toBe(true)
		expect(state.stash["1"]).toEqual({})
		expect(await stage()).toBe("adopted")

		await run.legacy.drain("1")

		expect(run.ops()).not.toContain("drainCache")
		expect(await exists("networkDrive")).toBe(false)
		expect(await stage()).toBe("done")
		expect(await run.legacy.wanted("1")).toBe(false)
	})

	it("an old drive cache no role runs on is drained where it is and kept while uploads are pending", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")

		const state = shared({ "1": { networkDrive: oldDrive(false) } })
		const run = setup(state, { answers: { drainCache: () => ({ pending: 3, errored: 0 }) } })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(run.argsOf("drainCache")).toEqual([
			{
				binary: BINARY,
				stateDir: path.join(directory, "mounts", "1", "drain"),
				dir: path.join(directory, "networkDrive", "cache"),
				timeoutMs: 30 * 60_000
			}
		])
		expect(await exists("networkDrive/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await exists("mounts/1/cache")).toBe(false)
		expect((await run.store()).notices).toContain("legacyUploadsPending")
		expect(await stage()).toBe("adopted")
		// Tried again on the next launch, not by keeping the host up now.
		expect(await run.legacy.wanted("1")).toBe(false)
		expect(await setup(state).legacy.wanted("1")).toBe(true)
	})

	it("serve caches deleted only after zero pending", async () => {
		await put("rclone-cache/webdav/vfs/Filen/w.txt")
		await mkdir(path.join(directory, "rclone-cache", "s3", "vfs", "Filen"), { recursive: true })

		const state = shared()
		let pending = 2
		const run = setup(state, { answers: { drainCache: () => ({ pending, errored: 0 }) } })

		expect(await run.legacy.wanted("1")).toBe(true)
		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(await exists("rclone-cache/webdav/vfs/Filen/w.txt")).toBe(true)
		expect(await exists("rclone-cache/s3")).toBe(false)
		expect((await run.store()).notices).toEqual(["legacyUploadsPending"])

		// The next launch.
		pending = 0

		const next = setup(state, { answers: { drainCache: () => ({ pending, errored: 0 }) } })

		await next.legacy.prepare("1")
		await next.legacy.drain("1")

		expect(next.ops()).toEqual(["drainCache"])
		expect(await exists("rclone-cache")).toBe(false)
		expect((await next.store()).notices).toEqual([])
		expect(await stage()).toBe("done")
	})

	it("errored cache kept with notice", async () => {
		await put("rclone-cache/s3/vfs/Filen/s.txt")

		const run = setup(shared(), { answers: { drainCache: () => ({ pending: 0, errored: 1 }) } })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(await exists("rclone-cache/s3/vfs/Filen/s.txt")).toBe(true)
		expect((await run.store()).notices).toEqual(["legacyCacheErrored"])
		expect(await stage()).toBe("adopted")
	})

	it("a drain the host could not finish keeps the cache", async () => {
		await put("rclone-cache/webdav/vfs/Filen/w.txt")

		const run = setup(shared(), { answers: { drainCache: () => ({ refuse: "timeout" }) } })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(await exists("rclone-cache/webdav/vfs/Filen/w.txt")).toBe(true)
		expect((await run.store()).notices).toEqual(["legacyUploadsPending"])
	})

	it("without rclone nothing is drained or deleted", async () => {
		await put("rclone-cache/webdav/vfs/Filen/w.txt")

		const run = setup(shared(), { binary: false })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(run.ops()).toEqual(["quiesceLegacy"])
		expect(await exists("rclone-cache/webdav/vfs/Filen/w.txt")).toBe(true)
	})

	it("rerun after crash is idempotent", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")
		await mkdir(path.join(directory, "home", "Filen"), { recursive: true })

		const state = shared({ "1": { networkDrive: oldDrive(), webdav: STRONG_WEBDAV } })
		// Crashed before the stash was consumed.
		const first = setup(state, { consumeFails: true })

		await first.legacy.prepare("1")

		const imported = await first.store()

		expect(imported.legacyApplied).toBe(true)
		expect(await first.credentials.get("webdav")).toEqual({ kind: "basic", user: "filen-user-01", password: "a-strong-passphrase-42" })
		expect(state.stash["1"]).toHaveProperty("networkDrive")

		const second = setup(state)

		await second.legacy.prepare("1")

		expect(second.ops()).toEqual([])
		expect(await second.store()).toBe(imported)
		expect(second.consume.mock.calls.map(([, feature]) => feature).sort()).toEqual(["networkDrive", "webdav"])
		expect(state.stash["1"]).toEqual({})
		expect(await exists("mounts/1/cache/vfs/Filen/a.txt")).toBe(true)
	})

	it("a crash between the adoption and its record moves nothing twice", async () => {
		await put("mounts/1/cache/vfs/Filen/a.txt")
		await put("networkDrive/other")
		await writeFile(path.join(directory, "mounts", "legacy.json"), JSON.stringify({ version: 1, stage: "quiesced" }))

		const run = setup(shared({}, { "1": { ...DEFAULT_MOUNTS, drive: { ...DEFAULT_MOUNTS.drive, enabled: true, mountPoint: "/x" } } }))

		await run.legacy.prepare("1")

		expect(run.ops()).toEqual([])
		expect(await exists("mounts/1/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await stage()).toBe("adopted")
		expect(run.warn).not.toHaveBeenCalled()
	})

	it("a failed quiesce touches no old directory", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")
		await put("rclone/bin/1.74.3/rclone")
		await mkdir(path.join(directory, "home", "Filen"), { recursive: true })

		const state = shared({ "1": { networkDrive: oldDrive() } })
		const run = setup(state, { answers: { quiesceLegacy: () => ({ refuse: "timeout" }) } })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(await exists("networkDrive/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await exists("rclone/bin/1.74.3/rclone")).toBe(true)
		expect(await exists("mounts/legacy.json")).toBe(false)
		expect(run.ops()).toEqual(["quiesceLegacy"])
		// The settings still come over.
		expect((await run.store()).drive.enabled).toBe(true)
	})

	it("only the old account's session adopts or drains its caches", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")

		const state = shared({ "1": { s3: { enabled: false } } })
		const run = setup(state, { owner: "2" })

		await run.legacy.prepare("1")
		await run.legacy.drain("1")

		expect(run.ops()).toEqual(["quiesceLegacy"])
		expect(await exists("networkDrive/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await stage()).toBe("quiesced")
		expect(await run.legacy.wanted("1")).toBe(false)
		expect(await run.legacy.wanted("2")).toBe(true)
	})

	it("caches of an unknown account are kept", async () => {
		await put("networkDrive/cache/vfs/Filen/a.txt")

		const run = setup(shared(), { owner: null })

		await run.legacy.prepare("1")

		expect(await exists("networkDrive/cache/vfs/Filen/a.txt")).toBe(true)
		expect(await stage()).toBe("done")

		// Not known yet: nothing is decided.
		await rm(path.join(directory, "mounts"), { recursive: true })

		const waiting = setup(shared(), { owner: undefined })

		await waiting.legacy.prepare("1")
		expect(await stage()).toBe("quiesced")
	})

	it("settings made in this app are kept", async () => {
		const configured: MountsConfig = { ...DEFAULT_MOUNTS, serves: { ftp: defaultServe("ftp") } }
		const state = shared({ "1": { webdav: STRONG_WEBDAV } }, { "1": configured })
		const run = setup(state)

		await run.legacy.prepare("1")

		expect(await run.store()).toEqual({ ...configured, legacyApplied: true })
		expect(await run.credentials.get("webdav")).toBeNull()
		expect(state.stash["1"]).toEqual({})
	})

	it("nothing to do without old directories or settings", async () => {
		const run = setup(shared())

		expect(await run.legacy.wanted("1")).toBe(false)
		await run.legacy.prepare("1")
		await run.legacy.drain("1")
		expect(run.ops()).toEqual([])
	})
})
