import type { JsClient, JsRcloneDaemon, RcloneExit, RcloneStats } from "@filen/sdk-rs"
import type { DesktopMountsRole, DesktopMountsRoleState } from "@filen/shared/desktop"
import type {
	FromNative,
	MountsOp,
	NativeMountsDesired,
	NativeMountsError,
	NativeMountsStatus,
	NativeOpArgs,
	NativeOpResult
} from "../../shared/nativeProtocol.ts"
import { serialQueue } from "../../shared/serial.ts"
import type { NativeSdk } from "../addon.ts"
import { cacheUsage } from "./cacheUsage.ts"
import { classifyMounts, MountsError } from "./errors.ts"
import { DAEMON_STOP_GRACE_MS, drainCache, type LegacyContext, quiesceLegacy } from "./legacy.ts"
import { daemonKey, type RoleSpec, serveOptions, vfsTuning, type WantedRole, wantedRoles } from "./reconcile.ts"
import { createStatsPoller, EMPTY_STATS, IDLE_POLL_MS, mountsStats, sameMountPoint, SUBSCRIBED_POLL_MS, uploadsOf } from "./stats.ts"

// After rclone exits by itself the host starts it again: 1 s, doubling to 5 min; five exits within 10 min and the
// roles go into error until main applies again.
export const CRASH_BACKOFF_MS = 1000
export const CRASH_BACKOFF_MAX_MS = 5 * 60_000
export const CRASH_WINDOW_MS = 10 * 60_000
export const CRASH_LIMIT = 5

export type MountsOpHandlers = { [K in MountsOp]: (args: NativeOpArgs<K>) => Promise<NativeOpResult<K>> }

export interface MountsHostDeps {
	sdk: NativeSdk
	client: Pick<JsClient, "startRcloneDaemon">
	platform: NodeJS.Platform
	userAgent: string
	verifyBinary(path: string): Promise<boolean>
	post(message: Extract<FromNative, { t: "mounts" | "mountsStats" }>): void
	now(): number
	// The server no longer takes the session.
	onAuthFailed(): void
	log: { info(message: string): void; warn(message: string): void }
}

export interface MountsHost {
	ops: MountsOpHandlers
	// A page shows the stats: they are read and posted at 1 Hz.
	subscribe(on: boolean): void
	// Stops every rclone this host runs (no drain: the cache keeps what is not uploaded); nothing starts afterwards.
	shutdown(): Promise<void>
}

interface RoleRun {
	role: DesktopMountsRole
	key: string
	spec: RoleSpec
	state: DesktopMountsRoleState
	error: NativeMountsError | null
	// What rclone reported once the role ran: the serve's id, the drive's mount point.
	serveId: string | null
	mounted: string | null
}

interface DaemonRun {
	daemon: JsRcloneDaemon
	key: string
	stateDir: string
	cacheDir: string
	// Stopped on purpose: its exit is no crash.
	stopping: boolean
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// The mounts half of the native host: one rclone for every role, reconciled to the last desired state main sent.
export function createMountsHost(deps: MountsHostDeps): MountsHost {
	const { sdk, log } = deps
	const queue = serialQueue()
	const roles = new Map<DesktopMountsRole, RoleRun>()
	const drains = new Set<Promise<unknown>>()
	const abort = new AbortController()
	let daemon: DaemonRun | null = null
	// What the daemon's caches hold; null while no rclone runs.
	let uploads: NativeMountsStatus["uploads"] = null
	let desired: NativeMountsDesired | null = null
	let subscribed = false
	let closed = false
	let lastPosted: string | null = null
	let crashes: number[] = []
	let retryTimer: NodeJS.Timeout | null = null
	const legacy: LegacyContext = { sdk, client: deps.client, userAgent: deps.userAgent, verifyBinary: deps.verifyBinary, log }

	const poller = createStatsPoller(
		() => (closed || daemon === null ? null : subscribed ? SUBSCRIBED_POLL_MS : IDLE_POLL_MS),
		async () => {
			const run = daemon

			if (run === null) {
				return
			}

			try {
				const stats = await run.daemon.stats()

				if (daemon !== run) {
					return
				}

				observe(stats)

				if (subscribed && !closed) {
					deps.post({ t: "mountsStats", stats: mountsStats(stats) })
				}
			} catch {
				// rclone is stopping or gone; its exit reports itself.
			}
		}
	)

	function status(): NativeMountsStatus {
		return { roles: [...roles.values()].map(({ role, state, error }) => ({ role, state, error })), uploads }
	}

	// Posts the status when it differs from the last one posted.
	function publish(): void {
		const next = status()
		const json = JSON.stringify(next)

		if (json !== lastPosted && !closed) {
			lastPosted = json
			deps.post({ t: "mounts", status: next })
		}
	}

	function fail(error: unknown): NativeMountsError {
		const failure = classifyMounts(sdk, error)

		if (failure === "unauthenticated") {
			deps.onAuthFailed()

			return { code: "unauthenticated" }
		}

		return failure
	}

	// The uploads, and a drive that went from under rclone (unmounted by the user or the OS).
	function observe(stats: RcloneStats): void {
		uploads = uploadsOf(stats)

		const drive = roles.get("drive")
		const mounted = drive?.mounted ?? null

		if (drive?.state === "running" && mounted !== null && !stats.mounts.some(point => sameMountPoint(point, mounted, deps.platform))) {
			log.warn("mounts: the drive was unmounted outside the app")
			drive.state = "error"
			drive.error = { code: "unknown", message: "The drive was unmounted outside Filen." }
			drive.mounted = null
		}

		publish()
	}

	async function refreshUploads(): Promise<void> {
		const run = daemon

		if (run === null) {
			return
		}

		try {
			const stats = await run.daemon.stats()

			if (daemon === run) {
				observe(stats)
			}
		} catch (error) {
			log.warn(`mounts: rclone's stats unavailable: ${describe(error)}`)
		}
	}

	function crashed(run: DaemonRun, exit: RcloneExit): void {
		if (daemon !== run || run.stopping || exit.tag === "Stopped") {
			return
		}

		daemon = null
		uploads = null
		log.warn(`mounts: rclone exited by itself (code ${String(exit.inner.code ?? "none")}): ${exit.inner.stderrTail}`)

		const at = deps.now()

		crashes = [...crashes.filter(time => at - time < CRASH_WINDOW_MS), at]

		const gaveUp = crashes.length >= CRASH_LIMIT

		for (const role of roles.values()) {
			role.serveId = null
			role.mounted = null
			role.state = gaveUp ? "error" : "starting"
			role.error = gaveUp ? { code: "unknown", message: "rclone keeps stopping." } : null
		}

		publish()
		poller.refresh()

		if (!gaveUp && !closed) {
			const delay = Math.min(CRASH_BACKOFF_MS * 2 ** (crashes.length - 1), CRASH_BACKOFF_MAX_MS)

			retryTimer = setTimeout(() => {
				retryTimer = null

				const again = desired

				if (again !== null) {
					void queue(() => reconcile(again)).catch((error: unknown) => {
						log.warn(`mounts: rclone not restarted: ${describe(error)}`)
					})
				}
			}, delay)
		}
	}

	async function startDaemon(target: NativeMountsDesired): Promise<DaemonRun> {
		if (!(await deps.verifyBinary(target.binary.path))) {
			throw new MountsError({ code: "binaryInvalid" })
		}

		const handle = await deps.client.startRcloneDaemon({
			binaryPath: target.binary.path,
			stateDir: target.stateDir,
			cacheDir: target.cacheDir,
			userAgent: deps.userAgent,
			vfs: vfsTuning(target.tuning),
			...(target.binary.sha256 === null ? {} : { binarySha256: target.binary.sha256 }),
			...(target.logFile === null ? {} : { logFile: target.logFile })
		})
		const run: DaemonRun = {
			daemon: handle,
			key: daemonKey(target),
			stateDir: target.stateDir,
			cacheDir: target.cacheDir,
			stopping: false
		}

		void handle.exited().then(exit => {
			crashed(run, exit)
		})
		log.info(`mounts: rclone started (pid ${String(handle.pid())})`)

		return run
	}

	async function stopDaemon(): Promise<void> {
		const run = daemon

		if (run === null) {
			return
		}

		run.stopping = true

		for (const role of roles.values()) {
			if (role.state === "running") {
				role.state = "stopping"
			}
		}

		publish()

		try {
			const report = await run.daemon.stop({ graceMs: DAEMON_STOP_GRACE_MS })

			log.info(`mounts: rclone stopped (${String(report.pendingUploads)} uploads kept${report.forced ? ", killed" : ""})`)
		} catch (error) {
			log.warn(`mounts: rclone did not stop cleanly: ${describe(error)}`)
		}

		if (daemon === run) {
			daemon = null
		}

		// Every role went with rclone.
		uploads = null
		roles.clear()
		poller.refresh()
	}

	// A role that keeps running when its stop failed (a busy drive) stays listed, in error, and is stopped again by the
	// next apply.
	async function stopRole(run: DaemonRun, role: RoleRun): Promise<void> {
		try {
			if (role.mounted !== null) {
				await run.daemon.unmount(role.mounted)
			} else if (role.serveId !== null) {
				await run.daemon.stopServe(role.serveId)
			}

			roles.delete(role.role)
		} catch (error) {
			role.state = "error"
			role.error = fail(error)
		}
	}

	async function startRole(run: DaemonRun, role: RoleRun): Promise<void> {
		try {
			if (role.spec.kind === "drive") {
				role.mounted = (await run.daemon.mount(role.spec.options)).mountPoint
			} else {
				role.serveId = (await run.daemon.startServe(serveOptions(sdk, role.spec.serve))).id
			}

			role.state = "running"
			role.error = null
		} catch (error) {
			role.state = "error"
			role.error = fail(error)
		}
	}

	// Stops what is no longer wanted or changed, then starts what is wanted and not running: new roles, and roles in
	// error (an unchanged apply retries them). rclone starts with the first wanted role and stops with the last.
	async function reconcile(target: NativeMountsDesired): Promise<NativeMountsStatus> {
		if (closed) {
			throw new MountsError({ code: "hostUnavailable" })
		}

		desired = target

		const wanted = wantedRoles(target)

		if (daemon !== null && (wanted.size === 0 || daemon.key !== daemonKey(target))) {
			await stopDaemon()
		}

		const current = daemon
		const leaving = [...roles.values()].filter(role => wanted.get(role.role)?.key !== role.key)

		if (leaving.length > 0) {
			for (const role of leaving) {
				role.state = "stopping"
			}

			publish()

			await Promise.all(
				leaving.map(role => {
					if (current === null) {
						roles.delete(role.role)

						return Promise.resolve()
					}

					return stopRole(current, role)
				})
			)
		}

		// A role whose old instance did not stop waits for it.
		const starting = [...wanted.values()]
			.filter((role: WantedRole) => roles.get(role.role) === undefined || roles.get(role.role)?.key === role.key)
			.filter(role => roles.get(role.role)?.state !== "running")
			.map((role): RoleRun => ({ ...role, state: "starting", error: null, serveId: null, mounted: null }))

		if (starting.length === 0) {
			publish()

			return status()
		}

		for (const role of starting) {
			roles.set(role.role, role)
		}

		publish()

		let run = daemon

		if (run === null) {
			try {
				run = await startDaemon(target)
			} catch (error) {
				const failure = fail(error)

				log.warn(`mounts: rclone not started: ${failure.code}${failure.message === undefined ? "" : `: ${failure.message}`}`)

				for (const role of starting) {
					role.state = "error"
					role.error = failure
				}

				publish()

				return status()
			}

			if (closed) {
				run.stopping = true
				await run.daemon.stop({ graceMs: DAEMON_STOP_GRACE_MS }).catch(() => undefined)

				throw new MountsError({ code: "hostUnavailable" })
			}

			daemon = run
		}

		const started = run

		await Promise.all(starting.map(role => startRole(started, role)))

		for (const role of starting) {
			if (role.error !== null) {
				log.warn(
					`mounts: ${role.role} not started: ${role.error.code}${role.error.message === undefined ? "" : `: ${role.error.message}`}`
				)
			}
		}

		await refreshUploads()
		poller.refresh()
		publish()

		return status()
	}

	function track<T>(job: Promise<T>): Promise<T> {
		drains.add(job)

		return job.finally(() => drains.delete(job))
	}

	const ops: MountsOpHandlers = {
		// main's apply: a restart backoff gives way to it, and the crash count starts over.
		mountsApply: ({ desired: target }) =>
			queue(() => {
				crashes = []

				if (retryTimer !== null) {
					clearTimeout(retryTimer)
					retryTimer = null
				}

				return reconcile(target)
			}),
		mountsStatus: async () => {
			await refreshUploads()

			return status()
		},
		mountsStats: async () => {
			const run = daemon

			return run === null ? EMPTY_STATS : mountsStats(await run.daemon.stats())
		},
		driveLetters: async () => (await sdk.rcloneAvailableDriveLetters()).filter(letter => /^[D-Z]$/.test(letter)),
		cacheUsage: ({ dir }) => cacheUsage(dir),
		// rclone refuses while a daemon runs on the cache or a file in it is not uploaded yet. One a crashed host left
		// running on `stateDir` is stopped first.
		clearCache: ({ stateDir, dir }) =>
			queue(async () => {
				if (daemon !== null && (daemon.stateDir === stateDir || daemon.cacheDir === dir)) {
					throw new MountsError({ code: "unknown", message: "The cache is in use." })
				}

				await sdk.rcloneRecoverStale(stateDir)
				await sdk.rcloneClearCache(stateDir, dir)

				return null
			}),
		quiesceLegacy: args => quiesceLegacy(legacy, args),
		drainCache: args => {
			if (closed) {
				return Promise.reject(new MountsError({ code: "hostUnavailable" }))
			}

			return track(drainCache(legacy, args, abort.signal, deps.now))
		}
	}

	return {
		ops,
		subscribe: on => {
			subscribed = on
			poller.refresh()
		},
		shutdown: async () => {
			if (closed) {
				return
			}

			closed = true
			abort.abort()
			poller.stop()

			if (retryTimer !== null) {
				clearTimeout(retryTimer)
				retryTimer = null
			}

			await Promise.all([stopDaemon(), ...[...drains].map(job => job.catch(() => undefined))])
		}
	}
}
