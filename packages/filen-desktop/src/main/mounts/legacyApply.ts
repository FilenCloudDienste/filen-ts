import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises"
import path from "node:path"
import { type } from "arktype"
import type { DesktopMountsNotice } from "@filen/shared/desktop"
import type { MountsOp, NativeMountsDesired, NativeOpArgs } from "../../shared/nativeProtocol.ts"
import { atomicFile, errorCode } from "../atomicFile.ts"
import type { LegacyFeature } from "../legacyData.ts"
import type { NativeMountsResult } from "../native/rpc.ts"
import { serialQueue } from "../serial.ts"
import { CREDENTIAL_PROTOCOLS, type CredentialStore } from "./credentials.ts"
import { wantsRoles } from "./desired.ts"
import { legacyDriveMountPoint, legacyMountsImport, type LegacyMountsInput } from "./legacyMounts.ts"
import type { MountPointContext } from "./mountPoint.ts"
import { anyEnabled, type MountsConfig, type MountsStore } from "./store.ts"

// PLAN §6.7: the old client's (3.x) rclone, its caches and the user's drive/WebDAV/S3 settings. The old rclone may
// outlive the old app by ~10 s (its watchdog reaps it), and its caches may hold writes not uploaded yet, so:
//   1. quiesce   the old rclone is stopped and a stale old mount unmounted, then the old binaries, TLS files and
//                watchdog scripts are deleted. Before any role of this app starts.
//   2. import    the user's old settings go into their store (credentials first), then the stash is consumed.
//   3. adopt     the old drive cache becomes the user's drive cache when a role will run on it (rclone resumes its
//                uploads); otherwise it stays where it is for step 4. Only for the old client's account: its pending
//                uploads belong there.
//   4. drain     each old cache still holding files runs on a temporary rclone until nothing is pending; it is deleted
//                only when nothing is pending nor errored. Otherwise it is kept with a notice and tried next launch.
// A device marker (`<userData>/mounts/legacy.json`) records steps 1, 3 and 4; step 2 is the store's `legacyApplied`.
// Every step is idempotent, so a crash anywhere reruns from the last recorded one.
//   (none)    nothing done; with none of the old directories present nothing is to be done
//   quiesced  the old rclone is gone, so its directories may be touched
//   adopted   the old drive cache was adopted or left for draining
//   done      every old cache is uploaded and deleted (or its account is unknown and it is kept)
export type LegacyMountsStage = "quiesced" | "adopted" | "done"

// The old watchdog's ~10 s plus stopping and unmounting.
export const LEGACY_QUIESCE_TIMEOUT_MS = 60_000
// How long one old cache may take to upload what it holds.
export const LEGACY_DRAIN_TIMEOUT_MS = 30 * 60_000
// What the host gets beyond the drain's own timeout to stop its temporary rclone and answer.
const DRAIN_REPLY_GRACE_MS = 60_000

const FEATURES = ["networkDrive", "webdav", "s3"] as const satisfies readonly LegacyFeature[]

const LEGACY_NOTICES: readonly DesktopMountsNotice[] = ["legacyUploadsPending", "legacyCacheErrored"]

const markerSchema = type({ version: "1", stage: "'quiesced' | 'adopted' | 'done'", "+": "delete" })

// The old client's watchdog scripts beside its rclone config.
const MONITOR_SCRIPT = /^monitor\.v\d+.*\.(?:sh|bat)$/

export interface LegacyMountsDeps {
	// The old client's rclone/, networkDrive/ and rclone-cache/ are in it; the marker goes to mounts/ there.
	userData: string
	// `<userData>/mounts/<userId>`.
	mountsDir(userId: string): string
	// The old client's signed-in account (the migration marker's): null when none, undefined while not known yet.
	owner(): Promise<string | null | undefined>
	binary: NativeMountsDesired["binary"] | null
	platform: NodeJS.Platform
	call<K extends MountsOp>(op: K, args: NativeOpArgs<K>, userId: string, timeoutMs?: number): Promise<NativeMountsResult<K>>
	stash: {
		pending(userId: string, feature: LegacyFeature): Promise<unknown>
		consume(userId: string, feature: LegacyFeature): Promise<void>
	}
	storeFor(userId: string): Promise<MountsStore>
	credentialsFor(userId: string): CredentialStore
	mountPointContext(userId: string): Promise<MountPointContext>
	log: { info(message: string): void; warn(message: string): void }
}

export interface LegacyMounts {
	// The host is wanted for it: old settings wait for the user, or old caches only the user's session may upload.
	wanted(userId: string): Promise<boolean>
	// Steps 1-3, on a host's `ready` before its first apply. Never rejects.
	prepare(userId: string): Promise<void>
	// Step 4, after the apply; one at a time. Never rejects.
	drain(userId: string): Promise<void>
}

// Whether `dir` holds a file anywhere below it (rclone leaves empty directories in an empty cache); stops at the first.
export async function holdsFiles(dir: string): Promise<boolean> {
	let entries

	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return false
		}

		throw error
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || (await holdsFiles(path.join(dir, entry.name)))) {
			return true
		}
	}

	return false
}

function exists(target: string): Promise<boolean> {
	return stat(target).then(
		() => true,
		() => false
	)
}

// Settings the user made in this app win over the old ones.
function configuredHere(config: MountsConfig): boolean {
	return (
		anyEnabled(config) || config.drive.mountPoint !== null || config.drive.driveLetter !== null || Object.keys(config.serves).length > 0
	)
}

export function createLegacyMounts(deps: LegacyMountsDeps): LegacyMounts {
	const rcloneDir = path.join(deps.userData, "rclone")
	const networkDrive = path.join(deps.userData, "networkDrive")
	const serveCaches = path.join(deps.userData, "rclone-cache")
	const driveCache = path.join(networkDrive, "cache")
	const oldCaches = [driveCache, path.join(serveCaches, "webdav"), path.join(serveCaches, "s3")]
	const markerPath = path.join(deps.userData, "mounts", "legacy.json")
	const marker = atomicFile(markerPath)
	// Marker writes share the file's temp sibling.
	const serial = serialQueue()
	// undefined: not read yet; null: nothing done.
	let stage: LegacyMountsStage | null | undefined
	let draining = false
	// A drain ran this app run: a cache it kept (an upload that keeps failing) waits for the next launch rather than
	// keeping the host up.
	let drainTried = false

	async function currentStage(): Promise<LegacyMountsStage | null> {
		if (stage !== undefined) {
			return stage
		}

		let read: LegacyMountsStage | null = null

		try {
			const data = await marker.read()
			const parsed = data === null ? null : markerSchema(JSON.parse(data.toString("utf8")))

			read = parsed === null || parsed instanceof type.errors ? null : parsed.stage
		} catch (error) {
			// Every step reruns safely.
			deps.log.warn(`mounts: the previous app's mounts marker is unreadable: ${errorCode(error)}`)
		}

		if (read === null) {
			const leftovers = await Promise.all([rcloneDir, networkDrive, serveCaches].map(exists))

			read = leftovers.includes(true) ? null : "done"
		}

		stage = read

		return read
	}

	function save(next: LegacyMountsStage): Promise<void> {
		return serial(async () => {
			await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 })
			await marker.write(Buffer.from(JSON.stringify({ version: 1, stage: next })))
			stage = next
		})
	}

	// The user's old settings; null when none wait.
	async function pendingInput(userId: string): Promise<LegacyMountsInput | null> {
		const [networkDrive, webdav, s3] = await Promise.all(FEATURES.map(feature => deps.stash.pending(userId, feature)))

		return networkDrive === undefined && webdav === undefined && s3 === undefined ? null : { networkDrive, webdav, s3 }
	}

	async function quiesce(userId: string, input: LegacyMountsInput | null): Promise<boolean> {
		const mountPoint = input === null ? null : legacyDriveMountPoint(input.networkDrive)
		const quiesced = await deps.call(
			"quiesceLegacy",
			{ binDir: path.join(rcloneDir, "bin"), mountPoints: mountPoint === null ? [] : [mountPoint] },
			userId,
			LEGACY_QUIESCE_TIMEOUT_MS
		)

		if (!quiesced.ok) {
			deps.log.warn(`mounts: the previous app's rclone is not stopped: ${quiesced.error.code}`)

			return false
		}

		deps.log.info(
			`mounts: the previous app's rclone stopped (${String(quiesced.value.stopped)} processes, ${String(quiesced.value.unmounted.length)} unmounted)`
		)

		// Nothing runs them any more; rclone.conf went with the migration.
		await Promise.all([
			rm(path.join(rcloneDir, "bin"), { recursive: true, force: true }),
			rm(path.join(rcloneDir, "tls"), { recursive: true, force: true })
		])

		const names = await readdir(rcloneDir).catch(() => [])

		await Promise.all(names.filter(name => MONITOR_SCRIPT.test(name)).map(name => rm(path.join(rcloneDir, name), { force: true })))
		// Only when nothing else is left in it.
		await rmdir(rcloneDir).catch(() => undefined)
		await save("quiesced")

		return true
	}

	// The credentials first and the store after them, then the stash: a crash before the store write reruns the
	// import, one after it only consumes.
	async function importSettings(userId: string, input: LegacyMountsInput): Promise<void> {
		const store = await deps.storeFor(userId)
		const current = store.get()

		if (!current.legacyApplied) {
			if (configuredHere(current)) {
				deps.log.info("mounts: settings made in this app kept; the previous app's are not imported")
				await store.update(config => ({ ...config, legacyApplied: true }))
			} else {
				const imported = legacyMountsImport(input, await deps.mountPointContext(userId))
				const credentials = deps.credentialsFor(userId)

				for (const protocol of CREDENTIAL_PROTOCOLS) {
					const kept = imported.credentials[protocol]

					if (kept !== undefined) {
						await credentials.set(protocol, kept)
					}
				}

				await store.update(config =>
					configuredHere(config) ? { ...config, legacyApplied: true } : { ...imported.config, tuning: config.tuning }
				)
				deps.log.info("mounts: the previous app's drive and server settings imported")
			}
		}

		for (const feature of FEATURES) {
			if (input[feature] !== undefined) {
				try {
					await deps.stash.consume(userId, feature)
				} catch (error) {
					// Applied already (legacyApplied): the next run only consumes.
					deps.log.warn(`mounts: the stash was not consumed: ${errorCode(error)}`)
				}
			}
		}
	}

	// The old drive cache becomes the user's when a role will run on it and the user's own holds nothing yet.
	async function adopt(userId: string): Promise<void> {
		const config = (await deps.storeFor(userId)).get()
		const target = path.join(deps.mountsDir(userId), "cache")

		if (deps.binary !== null && wantsRoles(config, deps.platform) && (await holdsFiles(driveCache)) && !(await holdsFiles(target))) {
			// Directories an earlier start left, nothing in them.
			await rm(target, { recursive: true, force: true })
			await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
			await rename(driveCache, target)
			deps.log.info("mounts: the previous app's drive cache adopted")
		}

		await save("adopted")
	}

	async function setNotices(userId: string, pending: boolean, errored: boolean): Promise<void> {
		const wanted = new Set<DesktopMountsNotice>([
			...(pending ? (["legacyUploadsPending"] as const) : []),
			...(errored ? (["legacyCacheErrored"] as const) : [])
		])

		await (
			await deps.storeFor(userId)
		).update(config => {
			const others = config.notices.filter(notice => !LEGACY_NOTICES.includes(notice))
			const next = [...others, ...wanted]

			return next.length === config.notices.length && next.every(notice => config.notices.includes(notice))
				? config
				: { ...config, notices: next }
		})
	}

	async function drainAll(userId: string): Promise<void> {
		let pending = false
		let errored = false

		for (const dir of oldCaches) {
			if (!(await holdsFiles(dir))) {
				await rm(dir, { recursive: true, force: true })

				continue
			}

			if (deps.binary === null) {
				deps.log.warn("mounts: no rclone in this build; the previous app's caches are kept")
				pending = true

				break
			}

			const stateDir = path.join(deps.mountsDir(userId), "drain")

			await mkdir(stateDir, { recursive: true, mode: 0o700 })

			const drained = await deps.call(
				"drainCache",
				{ binary: deps.binary, stateDir, dir, timeoutMs: LEGACY_DRAIN_TIMEOUT_MS },
				userId,
				LEGACY_DRAIN_TIMEOUT_MS + DRAIN_REPLY_GRACE_MS
			)

			if (!drained.ok) {
				// The host went (sign-out, crash) or refused: tried again on its next start.
				deps.log.warn(`mounts: a previous app's cache was not drained: ${drained.error.code}`)
				pending = true

				break
			}

			if (drained.value.pending === 0 && drained.value.errored === 0) {
				await rm(dir, { recursive: true, force: true })
				deps.log.info("mounts: a previous app's cache is uploaded and deleted")

				continue
			}

			pending ||= drained.value.pending > 0
			errored ||= drained.value.errored > 0
			deps.log.warn(
				`mounts: a previous app's cache kept: ${String(drained.value.pending)} pending, ${String(drained.value.errored)} errored`
			)
		}

		await setNotices(userId, pending, errored)

		if (!pending && !errored) {
			await Promise.all([rmdir(networkDrive).catch(() => undefined), rmdir(serveCaches).catch(() => undefined)])
			await save("done")
			deps.log.info("mounts: the previous app's caches are gone")
		}
	}

	return {
		wanted: async userId => {
			try {
				if ((await pendingInput(userId)) !== null) {
					return true
				}

				const current = await currentStage()

				return current !== "done" && !(current === "adopted" && drainTried) && (await deps.owner()) === userId
			} catch (error) {
				deps.log.warn(`mounts: the previous app's state is unreadable: ${errorCode(error)}`)

				return false
			}
		},
		prepare: async userId => {
			try {
				const input = await pendingInput(userId)
				let current = await currentStage()

				if (current === null && (await quiesce(userId, input))) {
					current = "quiesced"
				}

				if (input !== null) {
					await importSettings(userId, input)
				}

				if (current !== "quiesced") {
					return
				}

				const owner = await deps.owner()

				if (owner === userId) {
					await adopt(userId)
				} else if (owner === null) {
					deps.log.info("mounts: the previous app's caches belong to no known account; they are kept")
					await save("done")
				}
			} catch (error) {
				deps.log.warn(`mounts: the previous app's mounts not prepared: ${errorCode(error)}`)
			}
		},
		drain: async userId => {
			if (draining) {
				return
			}

			draining = true

			try {
				if ((await currentStage()) === "adopted" && (await deps.owner()) === userId) {
					drainTried = true
					await drainAll(userId)
				}
			} catch (error) {
				deps.log.warn(`mounts: the previous app's caches not drained: ${errorCode(error)}`)
			} finally {
				draining = false
			}
		}
	}
}
