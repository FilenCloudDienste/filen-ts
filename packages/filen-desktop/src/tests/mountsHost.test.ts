import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_TUNING, type FromNative, type NativeMountsDesired } from "../shared/nativeProtocol.ts"
import { createBinaryCheck, TEAM_REQUIREMENT } from "../native/mounts/binaryCheck.ts"
import { cacheUsage } from "../native/mounts/cacheUsage.ts"
import { classifyMounts } from "../native/mounts/errors.ts"
import { CRASH_BACKOFF_MS, CRASH_LIMIT, createMountsHost } from "../native/mounts/host.ts"
import { DRAIN_POLL_MS } from "../native/mounts/legacy.ts"
import { IDLE_POLL_MS, SUBSCRIBED_POLL_MS } from "../native/mounts/stats.ts"
import { fakeRclone, fakeSdk, rcloneError, rcloneStats, sdkError } from "./nativeFakes.ts"

const BASIC = { kind: "basic", user: "filen-0a1b2c3d", password: "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0" } as const
const WEBDAV = { protocol: "webdav", host: "127.0.0.1", port: 1900, auth: BASIC, tls: null, readOnly: false } as const

const DESIRED: NativeMountsDesired = {
	binary: { path: "/app/rclone/rclone", sha256: null },
	stateDir: "/data/mounts/1/state",
	cacheDir: "/data/mounts/1/cache",
	logFile: "/data/logs/rclone.log",
	tuning: DEFAULT_TUNING,
	drive: { mountPoint: "/Users/u/Filen", readOnly: false },
	serves: [WEBDAV]
}

const NOTHING: NativeMountsDesired = { ...DESIRED, drive: null, serves: [] }

function harness(options: { verified?: boolean } = {}) {
	const rclone = fakeRclone()
	const posted: FromNative[] = []
	const onAuthFailed = vi.fn()
	const host = createMountsHost({
		sdk: rclone.nativeSdk,
		client: rclone.client as never,
		platform: "darwin",
		userAgent: "filen-desktop/4.0.0",
		verifyBinary: () => Promise.resolve(options.verified ?? true),
		post: message => posted.push(message),
		now: Date.now,
		onAuthFailed,
		log: { info: () => undefined, warn: () => undefined }
	})
	const statuses = () => posted.flatMap(message => (message.t === "mounts" ? [message.status] : []))
	const stats = () => posted.filter(message => message.t === "mountsStats")

	return { ...rclone, host, posted, statuses, stats, onAuthFailed, daemon: (at = -1) => rclone.daemons.at(at) }
}

const states = (status: { roles: { role: string; state: string }[] }) =>
	Object.fromEntries(status.roles.map(role => [role.role, role.state]))

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("mountsHost", () => {
	it("daemon starts with the first role and stops with the last", async () => {
		const { host, client, daemon } = harness()

		expect(await host.ops.mountsApply({ desired: NOTHING })).toEqual({ roles: [], uploads: null })
		expect(client.startRcloneDaemon).not.toHaveBeenCalled()

		const running = await host.ops.mountsApply({ desired: DESIRED })

		expect(states(running)).toEqual({ drive: "running", webdav: "running" })
		expect(running.uploads).toEqual({ pending: 0, errored: 0 })
		expect(client.startRcloneDaemon).toHaveBeenCalledTimes(1)
		expect(client.startRcloneDaemon).toHaveBeenCalledWith({
			binaryPath: "/app/rclone/rclone",
			stateDir: DESIRED.stateDir,
			cacheDir: DESIRED.cacheDir,
			logFile: "/data/logs/rclone.log",
			userAgent: "filen-desktop/4.0.0",
			vfs: {
				cacheMaxSize: 32n * 1024n ** 3n,
				cacheMinFreeSpace: 16n * 1024n ** 3n,
				cacheMaxAgeSecs: 720n * 3600n,
				dirCacheTimeSecs: 15
			}
		})
		expect(daemon()?.daemon.mount).toHaveBeenCalledWith({ mountPoint: "/Users/u/Filen", readOnly: false })
		expect(daemon()?.daemon.startServe).toHaveBeenCalledWith({
			protocol: fakeSdk.ServeProtocol.Webdav,
			host: "127.0.0.1",
			port: 1900,
			auth: { tag: "Basic", inner: { user: BASIC.user, password: BASIC.password } },
			readOnly: false
		})

		// One role left: rclone keeps running, the other role stops.
		expect(states(await host.ops.mountsApply({ desired: { ...DESIRED, drive: null } }))).toEqual({ webdav: "running" })
		expect(daemon()?.daemon.unmount).toHaveBeenCalledWith("/Users/u/Filen")
		expect(daemon()?.daemon.stop).not.toHaveBeenCalled()

		expect(await host.ops.mountsApply({ desired: NOTHING })).toEqual({ roles: [], uploads: null })
		expect(daemon()?.daemon.stop).toHaveBeenCalledTimes(1)
		expect(client.startRcloneDaemon).toHaveBeenCalledTimes(1)
	})

	it("apply is idempotent", async () => {
		const { host, client, daemon, statuses } = harness()

		const first = await host.ops.mountsApply({ desired: DESIRED })
		const posts = statuses().length
		const again = await host.ops.mountsApply({ desired: DESIRED })

		expect(again).toEqual(first)
		expect(client.startRcloneDaemon).toHaveBeenCalledTimes(1)
		expect(daemon()?.daemon.mount).toHaveBeenCalledTimes(1)
		expect(daemon()?.daemon.startServe).toHaveBeenCalledTimes(1)
		// Nothing changed, so nothing new is pushed.
		expect(statuses()).toHaveLength(posts)
	})

	it("pushes the transitions and serializes concurrent applies", async () => {
		const { host, statuses, daemon } = harness()

		await Promise.all([host.ops.mountsApply({ desired: DESIRED }), host.ops.mountsApply({ desired: DESIRED })])

		expect(daemon()?.daemon.mount).toHaveBeenCalledTimes(1)
		expect(statuses().map(states)).toEqual([
			{ drive: "starting", webdav: "starting" },
			{ drive: "running", webdav: "running" }
		])
		expect(statuses().at(-1)?.uploads).toEqual({ pending: 0, errored: 0 })
	})

	it("an errored role is retried on an unchanged apply", async () => {
		const { host, daemons } = harness()

		await host.ops.mountsApply({ desired: { ...DESIRED, drive: null } })

		const running = daemons[0]

		running?.daemon.startServe.mockRejectedValueOnce(rcloneError({ tag: "PortInUse", inner: { port: 1900 } }))

		const refused = await host.ops.mountsApply({ desired: { ...DESIRED, serves: [{ ...WEBDAV, port: 1901 }] } })

		expect(refused.roles.find(role => role.role === "webdav")).toEqual({ role: "webdav", state: "error", error: { code: "portInUse" } })
		expect(refused.roles.find(role => role.role === "drive")?.state).toBe("running")

		const retried = await host.ops.mountsApply({ desired: { ...DESIRED, serves: [{ ...WEBDAV, port: 1901 }] } })

		expect(states(retried)).toEqual({ drive: "running", webdav: "running" })
		// The drive was not touched again.
		expect(running?.daemon.mount).toHaveBeenCalledTimes(1)
	})

	it("tuning change restarts roles", async () => {
		const { host, daemons } = harness()

		await host.ops.mountsApply({ desired: DESIRED })

		const status = await host.ops.mountsApply({ desired: { ...DESIRED, tuning: { ...DEFAULT_TUNING, cacheMaxGiB: 64 } } })

		expect(daemons).toHaveLength(2)
		expect(daemons[0]?.daemon.stop).toHaveBeenCalledTimes(1)
		expect(daemons[1]?.daemon.mount).toHaveBeenCalledTimes(1)
		expect(daemons[1]?.daemon.startServe).toHaveBeenCalledTimes(1)
		expect(states(status)).toEqual({ drive: "running", webdav: "running" })
	})

	it("a changed serve restarts only that serve", async () => {
		const { host, daemon } = harness()

		await host.ops.mountsApply({ desired: DESIRED })
		await host.ops.mountsApply({ desired: { ...DESIRED, serves: [{ ...WEBDAV, readOnly: true }] } })

		expect(daemon()?.daemon.stopServe).toHaveBeenCalledWith("serve-1")
		expect(daemon()?.daemon.startServe).toHaveBeenCalledTimes(2)
		expect(daemon()?.daemon.unmount).not.toHaveBeenCalled()
	})

	it("a drive that does not unmount stays listed in error and is stopped again on the next apply", async () => {
		const { host, daemon } = harness()

		await host.ops.mountsApply({ desired: DESIRED })
		daemon()?.daemon.unmount.mockRejectedValueOnce(sdkError(fakeSdk.ErrorKind.Io, "resource busy"))

		const busy = await host.ops.mountsApply({ desired: { ...DESIRED, drive: null } })

		expect(busy.roles.find(role => role.role === "drive")).toEqual({
			role: "drive",
			state: "error",
			error: { code: "unknown", message: "resource busy" }
		})
		expect(states(await host.ops.mountsApply({ desired: { ...DESIRED, drive: null } }))).toEqual({ webdav: "running" })
		expect(daemon()?.daemon.unmount).toHaveBeenCalledTimes(2)
	})

	it("crash backs off and re-applies", async () => {
		const { host, daemons, statuses } = harness()

		await host.ops.mountsApply({ desired: DESIRED })
		daemons[0]?.crash()
		await vi.advanceTimersByTimeAsync(0)

		expect(states(statuses().at(-1) ?? { roles: [] })).toEqual({ drive: "starting", webdav: "starting" })
		expect(statuses().at(-1)?.uploads).toBeNull()
		expect(daemons).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(CRASH_BACKOFF_MS)

		expect(daemons).toHaveLength(2)
		expect(states(statuses().at(-1) ?? { roles: [] })).toEqual({ drive: "running", webdav: "running" })

		// The second crash waits twice as long.
		daemons[1]?.crash()
		await vi.advanceTimersByTimeAsync(CRASH_BACKOFF_MS)
		expect(daemons).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(CRASH_BACKOFF_MS)
		expect(daemons).toHaveLength(3)
	})

	it("crashing again and again puts the roles in error until main applies", async () => {
		const { host, daemons, statuses } = harness()

		await host.ops.mountsApply({ desired: DESIRED })

		for (let crash = 1; crash <= CRASH_LIMIT; crash++) {
			daemons.at(-1)?.crash()
			await vi.advanceTimersByTimeAsync(60_000)
		}

		expect(daemons).toHaveLength(CRASH_LIMIT)
		expect(
			statuses()
				.at(-1)
				?.roles.every(role => role.state === "error")
		).toBe(true)

		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(daemons).toHaveLength(CRASH_LIMIT)

		expect(states(await host.ops.mountsApply({ desired: DESIRED }))).toEqual({ drive: "running", webdav: "running" })
		expect(daemons).toHaveLength(CRASH_LIMIT + 1)
	})

	it("no polling while idle and unsubscribed", async () => {
		const { host, daemon, stats } = harness()

		host.subscribe(true)
		await vi.advanceTimersByTimeAsync(10 * SUBSCRIBED_POLL_MS)
		// No rclone runs, so there is nothing to read.
		expect(stats()).toHaveLength(0)

		await host.ops.mountsApply({ desired: DESIRED })

		const reads = daemon()?.daemon.stats.mock.calls.length ?? 0

		await vi.advanceTimersByTimeAsync(3 * SUBSCRIBED_POLL_MS)
		expect(stats()).toHaveLength(3)

		host.subscribe(false)
		await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
		// Unsubscribed: the slow cadence for the tray, and no stats pushed.
		expect(stats()).toHaveLength(3)
		expect(daemon()?.daemon.stats.mock.calls.length).toBeLessThanOrEqual(reads + 5)

		await host.ops.mountsApply({ desired: NOTHING })

		const stopped = daemon()?.daemon.stats.mock.calls.length

		await vi.advanceTimersByTimeAsync(10 * IDLE_POLL_MS)
		expect(daemon()?.daemon.stats.mock.calls.length).toBe(stopped)
	})

	it("posts upload transitions from the slow poll", async () => {
		const { host, daemon, statuses } = harness()

		await host.ops.mountsApply({ desired: DESIRED })

		const running = daemon()

		if (running !== undefined) {
			running.state.stats = rcloneStats({ uploadsInProgress: 1, uploadsQueued: 2, erroredFiles: 1 })
		}

		await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
		expect(statuses().at(-1)?.uploads).toEqual({ pending: 3, errored: 1 })
		expect((await host.ops.mountsStatus({})).uploads).toEqual({ pending: 3, errored: 1 })
	})

	it("lost drive reported", async () => {
		const { host, daemon, statuses } = harness()

		await host.ops.mountsApply({ desired: DESIRED })

		const running = daemon()

		if (running !== undefined) {
			running.state.mounts = []
		}

		await vi.advanceTimersByTimeAsync(IDLE_POLL_MS)
		expect(
			statuses()
				.at(-1)
				?.roles.find(role => role.role === "drive")
		).toEqual({
			role: "drive",
			state: "error",
			error: { code: "unknown", message: "The drive was unmounted outside Filen." }
		})

		// The next apply mounts it again.
		expect(states(await host.ops.mountsApply({ desired: DESIRED }))).toEqual({ drive: "running", webdav: "running" })
		expect(running?.daemon.mount).toHaveBeenCalledTimes(2)
	})

	it("auth failure revokes", async () => {
		const { host, daemon, onAuthFailed } = harness()

		await host.ops.mountsApply({ desired: { ...DESIRED, drive: null } })
		daemon()?.daemon.mount.mockRejectedValueOnce(sdkError(fakeSdk.ErrorKind.Unauthenticated))

		const status = await host.ops.mountsApply({ desired: DESIRED })

		expect(status.roles.find(role => role.role === "drive")).toEqual({
			role: "drive",
			state: "error",
			error: { code: "unauthenticated" }
		})
		expect(onAuthFailed).toHaveBeenCalledTimes(1)
	})

	it("a binary that fails its check starts no rclone", async () => {
		const { host, client } = harness({ verified: false })

		const status = await host.ops.mountsApply({ desired: DESIRED })

		expect(client.startRcloneDaemon).not.toHaveBeenCalled()
		expect(status.roles.map(role => role.error)).toEqual([{ code: "binaryInvalid" }, { code: "binaryInvalid" }])
	})

	it("a refused start puts every wanted role in error", async () => {
		const { host, client } = harness()

		client.startRcloneDaemon.mockRejectedValueOnce(rcloneError({ tag: "UnsupportedVersion", inner: { found: "1.60.0" } }))

		expect((await host.ops.mountsApply({ desired: DESIRED })).roles).toEqual([
			{ role: "drive", state: "error", error: { code: "binaryInvalid" } },
			{ role: "webdav", state: "error", error: { code: "binaryInvalid" } }
		])
	})

	it("mountsStats reads rclone only while it runs", async () => {
		const { host, daemon } = harness()

		expect(await host.ops.mountsStats({})).toEqual({ transfers: [], uploadsInProgress: 0, uploadsQueued: 0 })

		await host.ops.mountsApply({ desired: DESIRED })

		const running = daemon()

		if (running !== undefined) {
			running.state.stats = rcloneStats({
				uploadsQueued: 1,
				transfers: [
					{ name: "a.txt", bytes: 5n, size: 10n, speedBps: 2n },
					{ name: "b.txt", bytes: 1n, speedBps: 0n }
				]
			})
		}

		expect(await host.ops.mountsStats({})).toEqual({
			transfers: [
				{ name: "a.txt", bytes: 5, total: 10, speed: 2 },
				{ name: "b.txt", bytes: 1, total: 0, speed: 0 }
			],
			uploadsInProgress: 0,
			uploadsQueued: 1
		})
	})

	it("clearCache refuses with pending uploads and while rclone runs on it", async () => {
		const { host, sdk } = harness()

		sdk.rcloneClearCache.mockRejectedValueOnce(rcloneError({ tag: "UploadsPending", inner: { count: 2 } }))
		await expect(host.ops.clearCache({ stateDir: DESIRED.stateDir, dir: DESIRED.cacheDir })).rejects.toSatisfy(
			error => JSON.stringify(classifyMounts(fakeSdk, error)) === JSON.stringify({ code: "uploadsPending" })
		)

		// A crashed host's rclone is stopped first.
		expect(sdk.rcloneRecoverStale).toHaveBeenCalledWith(DESIRED.stateDir)
		expect(await host.ops.clearCache({ stateDir: DESIRED.stateDir, dir: DESIRED.cacheDir })).toBeNull()
		expect(sdk.rcloneClearCache).toHaveBeenLastCalledWith(DESIRED.stateDir, DESIRED.cacheDir)

		await host.ops.mountsApply({ desired: DESIRED })
		await expect(host.ops.clearCache({ stateDir: DESIRED.stateDir, dir: DESIRED.cacheDir })).rejects.toThrow()
		expect(sdk.rcloneClearCache).toHaveBeenCalledTimes(2)
	})

	it("driveLetters offers D-Z only", async () => {
		const { host, sdk } = harness()

		sdk.rcloneAvailableDriveLetters.mockResolvedValueOnce(["C", "D", "X", "ZZ"])
		expect(await host.ops.driveLetters({})).toEqual(["D", "X"])
	})

	it("quiesceLegacy stops the old rclone and unmounts its stale drive, with no rclone of its own", async () => {
		const { host, sdk, client } = harness()

		sdk.rcloneStopUnder.mockResolvedValueOnce(1)
		sdk.rcloneForceUnmount.mockResolvedValueOnce(true)

		expect(await host.ops.quiesceLegacy({ binDir: "/data/rclone/bin", mountPoints: ["/tmp/filen"] })).toEqual({
			stopped: 1,
			unmounted: ["/tmp/filen"]
		})
		// Nothing left: it answers the same way with nothing done.
		expect(await host.ops.quiesceLegacy({ binDir: "/data/rclone/bin", mountPoints: ["/tmp/filen"] })).toEqual({
			stopped: 0,
			unmounted: []
		})
		expect(sdk.rcloneStopUnder).toHaveBeenCalledWith("/data/rclone/bin", 10_000)
		expect(client.startRcloneDaemon).not.toHaveBeenCalled()
	})

	describe("drainCache", () => {
		const args = { binary: DESIRED.binary, stateDir: "/data/mounts/1/drain", dir: "/data/rclone-cache/webdav", timeoutMs: 60_000 }

		it("runs a temporary rclone until nothing is pending, stopping it before it answers", async () => {
			const { host, client, daemons, sdk, initial } = harness()

			initial.stats = rcloneStats({ uploadsQueued: 2 })

			const drained = host.ops.drainCache(args)

			await vi.waitFor(() => {
				expect(daemons[0]?.daemon.stats).toHaveBeenCalled()
			})

			const temporary = daemons[0]
			const serve = temporary?.daemon.startServe.mock.calls[0]?.[0] as { host: string; auth: { tag: string } } | undefined

			expect(client.startRcloneDaemon).toHaveBeenCalledWith(expect.objectContaining({ stateDir: args.stateDir, cacheDir: args.dir }))
			expect(serve?.host).toBe("127.0.0.1")
			expect(serve?.auth.tag).toBe("Basic")
			expect(temporary?.daemon.stop).not.toHaveBeenCalled()

			if (temporary !== undefined) {
				temporary.state.stats = rcloneStats()
			}

			await vi.advanceTimersByTimeAsync(DRAIN_POLL_MS)

			expect(await drained).toEqual({ pending: 0, errored: 0 })
			expect(temporary?.daemon.stop).toHaveBeenCalledTimes(1)
			expect(sdk.rcloneClearCache).toHaveBeenCalledWith(args.stateDir, args.dir)
		})

		it("may run alongside the roles", async () => {
			const { host, daemons } = harness()

			await host.ops.mountsApply({ desired: DESIRED })
			expect(await host.ops.drainCache(args)).toEqual({ pending: 0, errored: 0 })
			expect(daemons).toHaveLength(2)
			expect(daemons[0]?.daemon.stop).not.toHaveBeenCalled()
		})

		it("keeps a cache whose files are dirty on disk although rclone reads none pending", async () => {
			const { host, sdk } = harness()

			sdk.rcloneClearCache.mockRejectedValueOnce(rcloneError({ tag: "UploadsPending", inner: { count: 3 } }))
			expect(await host.ops.drainCache(args)).toEqual({ pending: 3, errored: 0 })
		})

		it("answers with what is left at the timeout", async () => {
			const { host, daemons, sdk, initial } = harness()

			initial.stats = rcloneStats({ uploadsInProgress: 1, erroredFiles: 1 })

			const drained = host.ops.drainCache({ ...args, timeoutMs: 5000 })

			await vi.waitFor(() => {
				expect(daemons[0]?.daemon.stats).toHaveBeenCalled()
			})
			await vi.advanceTimersByTimeAsync(10_000)

			expect(await drained).toEqual({ pending: 1, errored: 1 })
			expect(daemons[0]?.daemon.stop).toHaveBeenCalledTimes(1)
			expect(sdk.rcloneClearCache).not.toHaveBeenCalled()
		})
	})

	it("shutdown stops rclone and starts nothing afterwards", async () => {
		const { host, daemon, client } = harness()

		await host.ops.mountsApply({ desired: DESIRED })
		await host.shutdown()

		expect(daemon()?.daemon.stop).toHaveBeenCalledTimes(1)
		await expect(host.ops.mountsApply({ desired: DESIRED })).rejects.toThrow()
		expect(client.startRcloneDaemon).toHaveBeenCalledTimes(1)
	})

	it("classifies the SDK's rclone refusals", () => {
		expect(classifyMounts(fakeSdk, rcloneError({ tag: "FuseMissing" }))).toEqual({ code: "fuseMissing" })
		expect(classifyMounts(fakeSdk, rcloneError({ tag: "ImplicitAddress" }))).toEqual({ code: "addressUnavailable" })
		expect(classifyMounts(fakeSdk, rcloneError({ tag: "MountPointNotEmpty" }))).toEqual({ code: "mountPointNotEmpty" })
		expect(classifyMounts(fakeSdk, rcloneError({ tag: "CacheInUse" }, "in use"))).toEqual({ code: "unknown", message: "in use" })
		expect(classifyMounts(fakeSdk, sdkError(fakeSdk.ErrorKind.Unauthenticated))).toBe("unauthenticated")
		expect(classifyMounts(fakeSdk, new Error("boom"))).toEqual({ code: "unknown", message: "boom" })
	})
})

describe("binaryCheck", () => {
	it("holds rclone to the team signature only where the app carries it (macOS)", async () => {
		const signed = new Set(["/Applications/Filen.app/Contents/Frameworks/Filen Helper.app/Contents/MacOS/Filen Helper"])
		const run = vi.fn((_file: string, args: readonly string[]) => Promise.resolve(signed.has(args.at(-1) ?? "")))
		const check = createBinaryCheck({ platform: "darwin", execPath: [...signed][0] ?? "", run, log: () => undefined })

		expect(await check("/Applications/Filen.app/Contents/Resources/rclone/rclone")).toBe(false)
		expect(run).toHaveBeenCalledWith("/usr/bin/codesign", [
			"--verify",
			"--strict",
			"-R",
			TEAM_REQUIREMENT,
			"/Applications/Filen.app/Contents/Resources/rclone/rclone"
		])

		signed.add("/Applications/Filen.app/Contents/Resources/rclone/rclone")
		// Checked once per host run.
		expect(await check("/Applications/Filen.app/Contents/Resources/rclone/rclone")).toBe(false)
		expect(run).toHaveBeenCalledTimes(2)
	})

	it("an unsigned app (development) does not check rclone; other platforms are checked elsewhere", async () => {
		const run = vi.fn(() => Promise.resolve(false))

		expect(await createBinaryCheck({ platform: "darwin", execPath: "/usr/local/bin/node", run, log: () => undefined })("/r")).toBe(true)
		expect(await createBinaryCheck({ platform: "linux", execPath: "/x", run, log: () => undefined })("/r")).toBe(true)
		expect(await createBinaryCheck({ platform: "win32", execPath: "/x", run, log: () => undefined })("/r")).toBe(true)
		expect(run).toHaveBeenCalledTimes(1)
	})
})

describe("cacheUsage", () => {
	it("sums the files below the cache and reads its volume's free space", async () => {
		vi.useRealTimers()

		const dir = await mkdtemp(path.join(tmpdir(), "filen-cache-usage-"))

		try {
			await mkdir(path.join(dir, "vfs", "Filen", "a"), { recursive: true })
			await writeFile(path.join(dir, "vfs", "Filen", "a", "one"), Buffer.alloc(100))
			await writeFile(path.join(dir, "two"), Buffer.alloc(23))

			const usage = await cacheUsage(dir)

			expect(usage.usedBytes).toBe(123)
			expect(usage.freeBytes).toBeGreaterThan(0)
			expect((await cacheUsage(path.join(dir, "missing", "cache"))).usedBytes).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
