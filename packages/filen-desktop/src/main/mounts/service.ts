import { mkdir, stat } from "node:fs/promises"
import type { NetworkInterfaceInfo } from "node:os"
import path from "node:path"
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron"
import type {
	DesktopCredentialProtocol,
	DesktopDrivePatch,
	DesktopFuseInstall,
	DesktopFuseStatus,
	DesktopListenAddress,
	DesktopMountPointChoice,
	DesktopMountsError,
	DesktopMountsErrorCode,
	DesktopMountsNotice,
	DesktopMountsOverview,
	DesktopMountsResult,
	DesktopMountsRole,
	DesktopMountsStats,
	DesktopServeCredentials,
	DesktopServePatch,
	DesktopServeProtocol,
	DesktopSyncHostState,
	DesktopVfsTuning
} from "@filen/shared/desktop"
import { CHANNELS, type MountsSubscription } from "../../shared/channels.ts"
import {
	authKindOf,
	HTTPS_PROTOCOLS,
	isLoopbackHost,
	type NativeAggregate,
	type NativeMountsDesired,
	type NativeMountsStatus
} from "../../shared/nativeProtocol.ts"
import type { NativeEvent, NativeSupervisor } from "../native/supervisor.ts"
import { errorCode } from "../atomicFile.ts"
import { type Page, pushThrottle } from "../pages.ts"
import { serialQueue } from "../serial.ts"
import type { RootTokens } from "../sync/localRoot.ts"
import { mountsAggregate, newlyFailedRoles } from "../tray.ts"
import { listenAddresses } from "./addresses.ts"
import type { LegacyMounts } from "./legacyApply.ts"
import { type CredentialStore, credentialsProblem } from "./credentials.ts"
import { mountsDesired, wantsRoles } from "./desired.ts"
import { chooseMountPoint, defaultMountPoint, inspectMountPoint, type MountPointContext, validDriveLetter } from "./mountPoint.ts"
import { mountedDrive, mountsOverview, offeredProtocols } from "./overview.ts"
import { DEFAULT_MOUNTS, defaultServe, type MountsServe, type MountsStore } from "./store.ts"
import type { ServeCertificate } from "./tls.ts"

// Overview pushes to a page at most this often.
export const MOUNTS_PUSH_INTERVAL_MS = 250
// What signing out waits for the host to stop rclone and clear the cache, each.
export const SIGN_OUT_STEP_TIMEOUT_MS = 30_000

const EMPTY_STATS: DesktopMountsStats = { transfers: [], uploadsInProgress: 0, uploadsQueued: 0 }

export interface MountsServiceDeps {
	supervisor: Pick<NativeSupervisor, "callMounts" | "subscribe" | "ensure" | "retry" | "user" | "state">
	platform: NodeJS.Platform
	storeFor(userId: string): Promise<MountsStore>
	credentialsFor(userId: string): CredentialStore
	// `<userData>/mounts/<userId>`: rclone's state, the cache and the certificates go below it.
	mountsDir(userId: string): string
	logFile: string | null
	// The bundled rclone; null when this build has none (or a packaged Linux build lacks its digest).
	binary: NativeMountsDesired["binary"] | null
	// fuse.ts: what mounts the drive here, looked up by main (rclone checks it again before mounting).
	fuse: {
		status(): Promise<DesktopFuseStatus>
		// linuxFuseGap on Linux; null elsewhere.
		gap(): "fuse3" | "device" | null
		// The bundled installer (WinFsp); null where the app ships none.
		install: (() => Promise<DesktopFuseInstall>) | null
	}
	// tls.ts ensureCertificate.
	certificate(dir: string, protocol: DesktopServeProtocol, hosts: readonly string[], now: number): Promise<ServeCertificate>
	// os.networkInterfaces().
	interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>
	tokens: RootTokens
	dialogs: {
		// Bound to the app's window.
		showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
		// Where the drive may not be mounted, with the user's sync pairs.
		mountPointContext(userId: string): Promise<MountPointContext>
		// Uploads from the drive are pending: true to sign out anyway.
		confirmSignOut(pending: number): Promise<boolean>
	}
	shell: { openPath(target: string): Promise<string> }
	clipboard: { writeText(text: string): void }
	// The old client's mounts (legacyApply.ts): prepared before a host's first apply, its caches drained after it.
	legacy: Pick<LegacyMounts, "prepare" | "drain">
	// The status changed; `failed` are the roles that just went into error.
	statusChanged(failed: DesktopMountsRole[]): void
	now(): number
	log: { info(message: string): void; warn(message: string): void }
}

type Result<T> = DesktopMountsResult<T>

export interface MountsTrayView {
	aggregate: NativeAggregate
	// Where the drive is mounted now.
	mountPoint: string | null
}

export interface MountsService {
	nativeEvent(message: NativeEvent, userId: string): void
	hostChanged(state: DesktopSyncHostState): void
	// Before the session goes: stops rclone and deletes the user's cache when no upload is left in it.
	signOut(userId: string): Promise<void>
	// The session is gone (signed out, revoked).
	signedOut(): void
	subscribe(page: Page, subscription: MountsSubscription): void
	pageGone(pageId: number): void
	trayView(): MountsTrayView
	overview(): Promise<DesktopMountsOverview>
	stats(): Promise<DesktopMountsStats>
	chooseMountPoint(): Promise<DesktopMountPointChoice>
	driveLetters(): Promise<Result<string[]>>
	setDrive(patch: DesktopDrivePatch): Promise<Result<null>>
	listenAddresses(): DesktopListenAddress[]
	setServe(protocol: DesktopServeProtocol, patch: DesktopServePatch): Promise<Result<null>>
	credentials(protocol: DesktopCredentialProtocol): Promise<Result<DesktopServeCredentials>>
	copyCredential(protocol: DesktopCredentialProtocol, part: "user" | "secret"): Promise<Result<null>>
	setCredentials(protocol: DesktopCredentialProtocol, credentials: DesktopServeCredentials): Promise<Result<null>>
	regenerateCredentials(protocol: DesktopCredentialProtocol): Promise<Result<null>>
	setTuning(tuning: DesktopVfsTuning): Promise<Result<null>>
	clearCache(): Promise<Result<null>>
	installFuse(): Promise<Result<DesktopFuseInstall>>
	revealDrive(): Promise<Result<null>>
	confirmSignOut(): Promise<boolean>
	dismissNotice(notice: DesktopMountsNotice): Promise<void>
	retryHost(): void
}

function fail(code: DesktopMountsErrorCode, message?: string): { ok: false; error: DesktopMountsError } {
	return { ok: false, error: message === undefined ? { code } : { code, message } }
}

const DONE = { ok: true, value: null } as const

// What this host run was told and reported, for the user it runs for.
interface HostRun {
	status: NativeMountsStatus | null
	applyError: DesktopMountsError | null
	// The last desired state sent; roles run only while it names some.
	desired: NativeMountsDesired | null
	cache: { usedBytes: number; freeBytes: number } | null
	// cacheUsage was asked this run.
	cacheAsked: boolean
}

function freshRun(): HostRun {
	return { status: null, applyError: null, desired: null, cache: null, cacheAsked: false }
}

function runsRoles(desired: NativeMountsDesired | null): boolean {
	return desired !== null && (desired.drive !== null || desired.serves.length > 0)
}

function nothing(desired: NativeMountsDesired): NativeMountsDesired {
	return { ...desired, drive: null, serves: [] }
}

// Between the page and the native host's rclone: the config lives in main's per-user store, the host is sent the
// whole desired state after every change and every start. Paths reach the host only from main's own dialog (by token)
// or main's own directories; credentials only from the encrypted store, and they are never logged.
export function createMountsService(deps: MountsServiceDeps): MountsService {
	const { supervisor, platform } = deps
	const overviewPages = new Map<number, Page>()
	const statsPages = new Map<number, Page>()
	let host = supervisor.state()
	// The user the host run and the fingerprints belong to.
	let hostUser: string | null = null
	let run = freshRun()
	const fingerprints = new Map<DesktopServeProtocol, string>()
	let fuse: DesktopFuseStatus | null = null
	let fuseGap: "fuse3" | "device" | null = null
	let fuseLookup: Promise<void> | null = null
	// Applies, cache clears and sign-out steps run one at a time.
	const queue = serialQueue()

	const schedulePush = pushThrottle(
		() => {
			void overview().then(current => {
				for (const page of overviewPages.values()) {
					page.send(CHANNELS.mountsOverview, current)
				}
			})
		},
		MOUNTS_PUSH_INTERVAL_MS,
		deps.now,
		() => overviewPages.size > 0
	)

	function resetUser(userId: string | null): void {
		hostUser = userId
		run = freshRun()
		fingerprints.clear()
	}

	function running(): boolean {
		return supervisor.state().state === "running"
	}

	// The host streams stats only while a page wants them and a role runs.
	function syncStatsSubscription(): void {
		supervisor.subscribe(statsPages.size > 0 && runsRoles(run.desired) && running(), "mounts")
	}

	function setStatus(next: NativeMountsStatus | null): void {
		const failed = newlyFailedRoles(run.status, next)

		run.status = next
		schedulePush()
		deps.statusChanged(failed)
	}

	async function overview(): Promise<DesktopMountsOverview> {
		const user = await supervisor.user()
		const config = user === null ? DEFAULT_MOUNTS : (await deps.storeFor(user.userId)).get()
		const own = user !== null && user.userId === hostUser

		return mountsOverview({
			host,
			available: deps.binary !== null,
			fuse,
			fuseGap,
			config,
			status: own ? run.status : null,
			applyError: own ? run.applyError : null,
			cache: own ? run.cache : null,
			fingerprints: own ? fingerprints : new Map(),
			platform
		})
	}

	function dirs(userId: string): { state: string; cache: string; tls: string } {
		const dir = deps.mountsDir(userId)

		return { state: path.join(dir, "state"), cache: path.join(dir, "cache"), tls: path.join(dir, "tls") }
	}

	async function certificateFor(userId: string, protocol: DesktopServeProtocol, host: string): Promise<ServeCertificate> {
		const hosts = host === "0.0.0.0" ? listenAddresses(deps.interfaces()).map(entry => entry.address) : [host]
		const certificate = await deps.certificate(dirs(userId).tls, protocol, hosts, deps.now())

		if (hostUser === userId) {
			fingerprints.set(protocol, certificate.fingerprint)
		}

		return certificate
	}

	// Sends `desired` and keeps what the host answered.
	async function send(userId: string, desired: NativeMountsDesired, timeoutMs?: number): Promise<Result<null>> {
		const applied = await supervisor.callMounts("mountsApply", { desired }, userId, timeoutMs)

		if (hostUser !== userId) {
			return applied.ok ? DONE : applied
		}

		run.desired = runsRoles(desired) || !applied.ok ? desired : null
		run.applyError = applied.ok ? null : applied.error

		if (applied.ok) {
			setStatus(applied.value)
		} else {
			deps.log.warn(`mounts: not applied: ${applied.error.code}`)
			schedulePush()
		}

		syncStatsSubscription()

		return applied.ok ? DONE : applied
	}

	// The desired state for the user's config, sent to a running host. A fresh host runs no role, so nothing is sent
	// while none is wanted and none was asked for.
	async function apply(userId: string): Promise<void> {
		if (!running() || hostUser !== userId) {
			return
		}

		const config = (await deps.storeFor(userId)).get()

		if (!wantsRoles(config, platform) && !runsRoles(run.desired)) {
			return
		}

		const { binary } = deps

		if (binary === null) {
			deps.log.warn("mounts: no rclone in this build")

			return
		}

		const { state, cache } = dirs(userId)

		await Promise.all([mkdir(state, { recursive: true, mode: 0o700 }), mkdir(cache, { recursive: true, mode: 0o700 })])
		await send(
			userId,
			await mountsDesired(config, {
				platform,
				binary,
				stateDir: state,
				cacheDir: cache,
				logFile: deps.logFile,
				credentials: deps.credentialsFor(userId),
				certificate: (protocol, host) => certificateFor(userId, protocol, host),
				warn: deps.log.warn
			})
		)
	}

	function queueApply(userId: string): Promise<void> {
		return queue(() => apply(userId)).catch((error: unknown) => {
			deps.log.warn(`mounts: not applied: ${errorCode(error)}`)
		})
	}

	// After a config change: a running host gets the new state now, a stopped one starts if a role is wanted.
	function changed(userId: string): void {
		schedulePush()

		if (running()) {
			void queueApply(userId)
		}

		supervisor.ensure("mounts changed")
	}

	// The cache's size, once per host run and only while a page shows it.
	function askCacheUsage(userId: string): void {
		if (run.cacheAsked || !running() || hostUser !== userId || deps.binary === null) {
			return
		}

		run.cacheAsked = true

		const asked = run

		void supervisor.callMounts("cacheUsage", { dir: dirs(userId).cache }, userId).then(cache => {
			if (asked === run) {
				run.cache = cache.ok ? cache.value : null
				schedulePush()
			}
		})
	}

	// Looked up when a page starts showing the overview and after an install; one lookup at a time.
	function lookUpFuse(): Promise<void> {
		fuseLookup ??= deps.fuse
			.status()
			.then(
				status => {
					fuse = status
					fuseGap = status.state === "missing" ? deps.fuse.gap() : null
				},
				(error: unknown) => {
					deps.log.warn(`mounts: FUSE status unavailable: ${errorCode(error)}`)
				}
			)
			.finally(() => {
				fuseLookup = null
				schedulePush()
			})

		return fuseLookup
	}

	// The uploads the drive's cache holds, fresh from rclone while it runs.
	async function uploads(userId: string): Promise<NativeMountsStatus["uploads"]> {
		if (hostUser !== userId || !runsRoles(run.desired) || !running()) {
			return null
		}

		const status = await supervisor.callMounts("mountsStatus", {}, userId)

		if (status.ok && hostUser === userId) {
			setStatus(status.value)
		}

		return status.ok ? status.value.uploads : (run.status?.uploads ?? null)
	}

	function driveNow(): string | null {
		return mountedDrive(run.desired?.drive?.mountPoint ?? null, run.status, platform)
	}

	async function signedInUser(): Promise<string | null> {
		return (await supervisor.user())?.userId ?? null
	}

	// Runs `change` for the signed-in user; without one the host is not available.
	async function forUser<T>(change: (userId: string) => Promise<Result<T>>): Promise<Result<T>> {
		const userId = await signedInUser()

		return userId === null ? fail("hostUnavailable") : change(userId)
	}

	async function updateServe(userId: string, protocol: DesktopServeProtocol, serve: MountsServe): Promise<void> {
		await (await deps.storeFor(userId)).update(config => ({ ...config, serves: { ...config.serves, [protocol]: serve } }))
	}

	return {
		nativeEvent: (message, userId) => {
			if (userId !== hostUser) {
				resetUser(userId)
			}

			switch (message.t) {
				case "ready":
					run = freshRun()
					// The old client's rclone is stopped and its cache adopted before any role starts here.
					void queue(() => deps.legacy.prepare(userId)).then(schedulePush)
					void queueApply(userId)
						.then(() => deps.legacy.drain(userId))
						.then(schedulePush)

					if (overviewPages.size > 0) {
						askCacheUsage(userId)
					}

					schedulePush()

					return
				case "mounts":
					setStatus(message.status)

					return
				case "mountsStats":
					for (const page of statsPages.values()) {
						page.send(CHANNELS.mountsStats, message.stats)
					}

					return
				default:
					return
			}
		},
		hostChanged: state => {
			host = state

			if (state.state !== "running") {
				const had = run.status

				run = freshRun()

				if (had !== null) {
					deps.statusChanged([])
				}
			}

			syncStatsSubscription()
			schedulePush()
		},
		signOut: userId =>
			queue(async () => {
				if (hostUser !== userId) {
					return
				}

				const pending = await uploads(userId)
				const desired = run.desired

				if (desired !== null && runsRoles(desired)) {
					await send(userId, nothing(desired), SIGN_OUT_STEP_TIMEOUT_MS)
				}

				const { cache } = dirs(userId)

				if ((pending?.pending ?? 0) + (pending?.errored ?? 0) > 0) {
					deps.log.info("mounts: signed out with uploads pending; the cache is kept")

					return
				}

				const exists = await stat(cache).then(
					() => true,
					() => false
				)

				if (!exists) {
					return
				}

				// rclone refuses while its metadata still marks items to upload.
				const cleared = await supervisor.callMounts("clearCache", { dir: cache }, userId, SIGN_OUT_STEP_TIMEOUT_MS)

				deps.log.info(cleared.ok ? "mounts: cache deleted on sign-out" : `mounts: cache kept on sign-out: ${cleared.error.code}`)
			}).catch((error: unknown) => {
				deps.log.warn(`mounts: sign-out cleanup failed: ${errorCode(error)}`)
			}),
		signedOut: () => {
			const had = run.status

			resetUser(null)
			syncStatsSubscription()
			schedulePush()

			if (had !== null) {
				deps.statusChanged([])
			}
		},
		subscribe: (page, subscription) => {
			if (subscription.overview && !overviewPages.has(page.id)) {
				overviewPages.set(page.id, page)
				void overview().then(current => {
					page.send(CHANNELS.mountsOverview, current)
				})
				void lookUpFuse()

				if (hostUser !== null) {
					askCacheUsage(hostUser)
				}
			} else if (!subscription.overview) {
				overviewPages.delete(page.id)
			}

			if (subscription.stats) {
				statsPages.set(page.id, page)
			} else {
				statsPages.delete(page.id)
			}

			syncStatsSubscription()
		},
		pageGone: pageId => {
			overviewPages.delete(pageId)

			if (statsPages.delete(pageId)) {
				syncStatsSubscription()
			}
		},
		trayView: () => {
			if (hostUser === null) {
				return { aggregate: "idle", mountPoint: null }
			}

			return { aggregate: mountsAggregate(run.status), mountPoint: driveNow() }
		},
		overview,
		stats: async () => {
			const userId = await signedInUser()

			if (userId === null || userId !== hostUser || !runsRoles(run.desired) || !running()) {
				return EMPTY_STATS
			}

			const stats = await supervisor.callMounts("mountsStats", {}, userId)

			return stats.ok ? stats.value : EMPTY_STATS
		},
		chooseMountPoint: async () => {
			const userId = await signedInUser()

			if (userId === null || platform === "win32") {
				return { status: "canceled" }
			}

			return chooseMountPoint(deps.dialogs.showOpenDialog, () => deps.dialogs.mountPointContext(userId), deps.tokens)
		},
		driveLetters: async () => {
			if (platform !== "win32") {
				return { ok: true, value: [] }
			}

			const letters = await supervisor.callMounts("driveLetters", {})

			return letters.ok ? { ok: true, value: letters.value } : letters
		},
		setDrive: patch =>
			forUser(async userId => {
				const store = await deps.storeFor(userId)
				const drive = { ...store.get().drive }
				const windows = platform === "win32"

				if (patch.mountPointId !== undefined) {
					const chosen = deps.tokens.take(patch.mountPointId)

					if (windows || chosen === null) {
						return fail("mountPointExpired")
					}

					// The directory may have changed since it was chosen.
					const inspected = await inspectMountPoint(chosen, await deps.dialogs.mountPointContext(userId))

					if (inspected.problem !== null) {
						return fail("mountPointInvalid", inspected.problem)
					}

					drive.mountPoint = inspected.path
				}

				if (patch.driveLetter !== undefined || (windows && patch.enabled === true && drive.driveLetter === null)) {
					if (!windows) {
						return fail("mountPointInvalid")
					}

					const letters = await supervisor.callMounts("driveLetters", {}, userId)

					if (!letters.ok) {
						return letters
					}

					const letter = patch.driveLetter ?? defaultMountPoint("", platform, letters.value)

					if (letter === null || (letter !== drive.driveLetter && !validDriveLetter(letter, letters.value))) {
						return fail("driveLetterInUse")
					}

					drive.driveLetter = letter
				}

				// Enabled without a mount point: ~/Filen, made when missing.
				if (!windows && patch.enabled === true && drive.mountPoint === null) {
					const context = await deps.dialogs.mountPointContext(userId)
					const target = defaultMountPoint(context.home, platform, [])

					if (target !== null) {
						await mkdir(target, { recursive: true, mode: 0o700 }).catch(() => undefined)
					}

					const inspected = target === null ? null : await inspectMountPoint(target, context)

					if (inspected === null || inspected.problem !== null) {
						return fail("mountPointInvalid", inspected?.problem ?? undefined)
					}

					drive.mountPoint = inspected.path
				}

				drive.readOnly = patch.readOnly ?? drive.readOnly
				drive.enabled = patch.enabled ?? drive.enabled

				await store.update(config => ({ ...config, drive }))
				changed(userId)

				return DONE
			}),
		listenAddresses: () => listenAddresses(deps.interfaces()),
		setServe: (protocol, patch) =>
			forUser(async userId => {
				if (!offeredProtocols(platform).includes(protocol)) {
					return fail("unsupportedProtocol")
				}

				const config = (await deps.storeFor(userId)).get()
				const current = config.serves[protocol] ?? defaultServe(protocol)
				const next = { ...current }

				if (patch.address !== undefined && patch.address !== current.host) {
					const offered = listenAddresses(deps.interfaces()).some(entry => entry.address === patch.address)

					if (!offered || (protocol === "nfs" && !isLoopbackHost(patch.address))) {
						return fail("addressUnavailable")
					}

					// Credentials must not cross the LAN in plain text unless the user says so.
					if (isLoopbackHost(current.host) && !isLoopbackHost(patch.address) && HTTPS_PROTOCOLS.has(protocol)) {
						next.https = true
					}

					next.host = patch.address
				}

				if (patch.https === true && !HTTPS_PROTOCOLS.has(protocol)) {
					return fail("unsupportedProtocol")
				}

				next.port = patch.port ?? next.port
				next.https = patch.https ?? next.https
				next.readOnly = patch.readOnly ?? next.readOnly
				next.acknowledgedUnauthenticated = patch.acknowledgeUnauthenticated ?? next.acknowledgedUnauthenticated
				next.enabled = patch.enabled ?? next.enabled

				if (next.enabled) {
					if (authKindOf(protocol) === "none" && !next.acknowledgedUnauthenticated) {
						return fail("acknowledgementRequired")
					}

					const clash = Object.entries(config.serves).some(
						([other, serve]) =>
							other !== protocol &&
							serve.enabled &&
							serve.port === next.port &&
							(serve.host === next.host || serve.host === "0.0.0.0" || next.host === "0.0.0.0")
					)

					if (clash) {
						return fail("portInUse")
					}

					// Made before the config names them, so a locked keychain leaves the server as it was.
					try {
						if (protocol !== "nfs") {
							await deps.credentialsFor(userId).ensure(protocol)
						}

						if (next.https) {
							await certificateFor(userId, protocol, next.host)
						}
					} catch (error) {
						return fail("unknown", errorCode(error))
					}
				}

				await updateServe(userId, protocol, next)
				changed(userId)

				return DONE
			}),
		credentials: protocol =>
			forUser(async userId => {
				try {
					return { ok: true, value: await deps.credentialsFor(userId).ensure(protocol) }
				} catch (error) {
					return fail("unknown", errorCode(error))
				}
			}),
		copyCredential: (protocol, part) =>
			forUser(async userId => {
				let credentials: DesktopServeCredentials

				try {
					credentials = await deps.credentialsFor(userId).ensure(protocol)
				} catch (error) {
					return fail("unknown", errorCode(error))
				}

				const [user, secret] =
					credentials.kind === "basic"
						? [credentials.user, credentials.password]
						: [credentials.accessKeyId, credentials.secretAccessKey]

				deps.clipboard.writeText(part === "user" ? user : secret)

				return DONE
			}),
		setCredentials: (protocol, credentials) =>
			forUser(async userId => {
				if (credentials.kind !== authKindOf(protocol)) {
					return fail("credentialsInvalid")
				}

				const problem = credentialsProblem(credentials)

				if (problem !== null) {
					return fail(problem === "weak" ? "credentialsWeak" : "credentialsInvalid")
				}

				try {
					await deps.credentialsFor(userId).set(protocol, credentials)
				} catch (error) {
					return fail("unknown", errorCode(error))
				}

				changed(userId)

				return DONE
			}),
		regenerateCredentials: protocol =>
			forUser(async userId => {
				try {
					await deps.credentialsFor(userId).regenerate(protocol)
				} catch (error) {
					return fail("unknown", errorCode(error))
				}

				changed(userId)

				return DONE
			}),
		setTuning: tuning =>
			forUser(async userId => {
				await (await deps.storeFor(userId)).update(config => ({ ...config, tuning }))
				changed(userId)

				return DONE
			}),
		clearCache: () =>
			forUser(userId =>
				queue(async () => {
					const pending = (await uploads(userId)) ?? run.status?.uploads ?? null

					if ((pending?.pending ?? 0) + (pending?.errored ?? 0) > 0) {
						return fail("uploadsPending")
					}

					const desired = run.desired

					if (desired !== null && runsRoles(desired)) {
						const stopped = await send(userId, nothing(desired))

						if (!stopped.ok) {
							return stopped
						}
					}

					const { cache } = dirs(userId)
					const cleared = await supervisor.callMounts("clearCache", { dir: cache }, userId)

					await apply(userId)

					if (hostUser === userId) {
						run.cacheAsked = false
						askCacheUsage(userId)
					}

					return cleared.ok ? DONE : cleared
				})
			),
		installFuse: async () => {
			const { install } = deps.fuse

			if (install === null) {
				return fail("fuseMissing")
			}

			const result = await install()

			await lookUpFuse()

			// A drive that could not mount for want of it tries again.
			if ((result === "installed" || result === "rebootRequired") && hostUser !== null) {
				await queueApply(hostUser)
			}

			return { ok: true, value: result }
		},
		revealDrive: () =>
			forUser(async userId => {
				const target = userId === hostUser ? driveNow() : null

				if (target === null) {
					return fail("unknown", "notMounted")
				}

				// openPath answers with an error message, "" on success.
				return (await deps.shell.openPath(target)) === "" ? DONE : fail("mountPointInvalid")
			}),
		confirmSignOut: async () => {
			const userId = await signedInUser()
			const pending = userId === null ? null : await uploads(userId)

			return (pending?.pending ?? 0) === 0 || deps.dialogs.confirmSignOut(pending?.pending ?? 0)
		},
		dismissNotice: async notice => {
			const userId = await signedInUser()

			if (userId !== null) {
				await (
					await deps.storeFor(userId)
				).update(config =>
					config.notices.includes(notice) ? { ...config, notices: config.notices.filter(entry => entry !== notice) } : config
				)
				schedulePush()
			}
		},
		retryHost: () => {
			supervisor.retry()
		}
	}
}
