import { type } from "arktype"
import type { SessionRead } from "../shared/channels.ts"
import { type AtomicFile, codedError, errorCode } from "./atomicFile.ts"
import { legacyPin, legacyPrefs, type LegacyPrefs, legacySession, legacyStash, parseReadResult, sessionUserId } from "./legacyData.ts"

// The one-time import from the old client (3.0.53), PLAN §6 steps 1-5 and 8. A marker file in userData records where
// it got to:
//   started   a read began; `failedStarts` counts the attempts that never reached `imported`
//   imported  session, PIN, prefs and the stash are stored; the old origin still holds its plaintext secrets
//   verified  the migrated account proved itself (an authed request, a sign-in as the same user) or the wait ran out;
//             the old secrets are wiped, `wiped` says whether that finished; LevelDB keeps deleted values on disk
//             until a compaction that may never come, so the launch after the wipe deletes the old origin's stores
//             before anything opens them, and `purged` records that
//   skipped   nothing to import (a fresh install, a session already in the vault) or too many failed attempts
export type MigrationStage = "started" | "imported" | "verified" | "skipped"

export interface MigrationMarker {
	stage: MigrationStage
	failedStarts: number
	// The old signed-in account, once imported (null: it had none).
	userId: number | null
	importedAt: number | null
	wiped: boolean
	purged: boolean
}

// A read that crashed or came back empty this many times is not tried again.
export const MAX_FAILED_STARTS = 3

// The old origin's secrets are wiped at the latest this long after the import, verified or not (offline, an account
// whose session the server no longer takes).
export const WIPE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const markerSchema = type({
	version: "1",
	stage: "'started' | 'imported' | 'verified' | 'skipped'",
	failedStarts: "0 <= number.integer < 1000",
	userId: type("1 < number.integer <= 9007199254740991").or("null"),
	importedAt: type("number.integer >= 0").or("null"),
	wiped: "boolean",
	"purged?": "boolean"
})

// null: no marker, or one that cannot be used (it is then decided afresh, which never overwrites a stored session).
export function parseMarker(data: string | null): MigrationMarker | null {
	if (data === null) {
		return null
	}

	let json: unknown

	try {
		json = JSON.parse(data)
	} catch {
		return null
	}

	const marker = markerSchema(json)

	if (marker instanceof type.errors) {
		return null
	}

	return {
		stage: marker.stage,
		failedStarts: marker.failedStarts,
		userId: marker.userId,
		importedAt: marker.importedAt,
		wiped: marker.wiped,
		purged: marker.purged ?? false
	}
}

export function serializeMarker(marker: MigrationMarker): string {
	return JSON.stringify({ version: 1, ...marker })
}

export type StartupDecision =
	| "run"
	// Nothing written: the vault cannot be read right now (a keychain locked at login), so ask again next launch.
	| "defer"
	| "skip-fresh"
	| "skip-session"
	| "skip-failed"
	| "none"

// Whether this launch imports. Only a launch with no marker can see a session the user stored in 4.x itself, so that
// is where a stored session ends it (a newer sign-in is never overwritten). A rerun after a crash imports again but
// leaves a session the earlier attempt already stored alone.
export function startupDecision(marker: MigrationMarker | null, legacyProfile: boolean, vault: SessionRead["status"]): StartupDecision {
	if (marker === null) {
		if (!legacyProfile) {
			return "skip-fresh"
		}

		if (vault === "present") {
			return "skip-session"
		}

		return vault === "unreadable" ? "defer" : "run"
	}

	if (marker.stage !== "started") {
		return "none"
	}

	if (marker.failedStarts >= MAX_FAILED_STARTS) {
		return "skip-failed"
	}

	return vault === "unreadable" ? "defer" : "run"
}

// Whether an imported marker stops waiting for verification: at once without an imported account (nothing to
// verify), else once the time limit passed. A clock set back counts from now.
export function verificationExpired(marker: MigrationMarker, now: number): boolean {
	return marker.stage === "imported" && (marker.userId === null || now - (marker.importedAt ?? now) >= WIPE_AFTER_MS)
}

// Whether a session proves the import: it belongs to the migrated account, the resumed one or a new sign-in as it.
export function verifiedBy(marker: MigrationMarker, sessionBlob: string | null): boolean {
	return (
		marker.stage === "imported" &&
		marker.userId !== null &&
		sessionBlob !== null &&
		sessionUserId(sessionBlob) === String(marker.userId)
	)
}

export interface MigrationDeps {
	marker: AtomicFile
	// The old profile's localStorage exists (a cheap check of its directory).
	legacyProfile(): Promise<boolean>
	// READ_SCRIPT's result from the old origin; rejects on a timeout or a failed load.
	readLegacy(): Promise<unknown>
	// The old options.v1.json, null when absent.
	readOptions(): Promise<string | null>
	// Runs WIPE_SCRIPT in the old origin (and removes the old rclone config); rejects unless all of it worked.
	wipeLegacy(): Promise<void>
	// Deletes the old origin's IndexedDB and the Local Storage store on disk. Only called before any window or storage
	// use in this launch; the new page loses its few localStorage values (theme choice, splash hint) once.
	purgeLegacyStores(): Promise<void>
	vault: { get(): Promise<SessionRead>; set(blob: string): Promise<void> }
	lock: { enabled(): boolean; set(pin: string): Promise<boolean> }
	prefs: { set(patch: LegacyPrefs & { launchAtLogin?: boolean }): Promise<unknown> }
	// The OS login item the old client registered.
	launchesAtLogin(): boolean
	applyLaunchAtLogin(enabled: boolean): Promise<void>
	// Encrypted like the vault; where the vault keeps the session in memory only, so is this (not written).
	writeStash(text: string): Promise<void>
	now(): number
	info(message: string): void
	warn(message: string): void
}

export interface MigrationResult {
	// A PIN was imported: the app lock is now enabled.
	pinImported: boolean
}

export interface Migration {
	// Imports when this launch should (before any window exists) and starts a wipe that is due. Never rejects.
	start(): Promise<MigrationResult>
	// A session the page uses: resumed and confirmed by an authed request, or newly stored (a sign-in). Never rejects.
	sessionConfirmed(sessionBlob: string | null): Promise<void>
}

export function createMigration(deps: MigrationDeps): Migration {
	let marker: MigrationMarker | null = null
	let tail: Promise<unknown> = Promise.resolve()

	function serial(operation: () => Promise<void>): Promise<void> {
		const run = tail.then(operation, operation)

		tail = run.catch(() => undefined)

		return run
	}

	async function save(next: MigrationMarker): Promise<void> {
		await deps.marker.write(Buffer.from(serializeMarker(next)))
		marker = next
	}

	function fresh(stage: MigrationStage): MigrationMarker {
		return { stage, failedStarts: 0, userId: null, importedAt: null, wiped: false, purged: false }
	}

	// Errors are logged by their code only: none of this may ever log a value.
	async function attempt(previous: MigrationMarker | null): Promise<MigrationResult> {
		await save({ ...(previous ?? fresh("started")), stage: "started", failedStarts: (previous?.failedStarts ?? 0) + 1 })

		const read = parseReadResult(await deps.readLegacy())

		if (read === null) {
			throw codedError("unexpected read result")
		}

		deps.info(`migration: read keys=${String(read.count)}`)

		// The old web app wrote its defaults on first start, so a profile that has run holds keys: none means the read
		// missed the origin. Tried again next launch; nothing is cleared.
		if (read.count === 0) {
			throw codedError("no keys")
		}

		const { snapshot } = read
		const session = legacySession(snapshot)
		const stored = await deps.vault.get()

		if (stored.status === "unreadable") {
			throw codedError("vault unreadable")
		}

		if (!session.ok) {
			deps.info(`migration: no session imported (${session.reason})`)
		} else if (stored.status === "present") {
			deps.info("migration: a session is stored already; keeping it")
		} else {
			await deps.vault.set(session.blob)
			deps.info("migration: session imported")
		}

		const userId = session.ok ? session.userId : null
		const stash = legacyStash(snapshot, userId)

		if (stash !== null) {
			await deps.writeStash(JSON.stringify(stash))
			deps.info("migration: sync and mount settings stashed")
		}

		let pinImported = false
		const pin = session.ok ? legacyPin(snapshot) : null

		if (pin !== null && !deps.lock.enabled()) {
			pinImported = await deps.lock.set(pin)
			deps.info(pinImported ? "migration: app lock PIN imported" : "migration: app lock PIN not imported")
		}

		const prefs = legacyPrefs(snapshot, await deps.readOptions())
		const launchAtLogin = deps.launchesAtLogin()

		if (Object.keys(prefs).length > 0 || launchAtLogin) {
			await deps.prefs.set(launchAtLogin ? { ...prefs, launchAtLogin } : prefs)
			deps.info("migration: preferences imported")
		}

		// Registered again in this app's form; the setting is kept even if that fails.
		if (launchAtLogin) {
			await deps.applyLaunchAtLogin(true).catch((error: unknown) => {
				deps.warn(`migration: launch at login not re-registered: ${errorCode(error)}`)
			})
		}

		await save({ ...(marker ?? fresh("started")), stage: "imported", userId, importedAt: deps.now() })

		return { pinImported }
	}

	// From `verified` until the wipe worked once; a failure retries on the next confirmation or launch.
	async function wipeIfDue(): Promise<void> {
		if (marker === null) {
			return
		}

		if (verificationExpired(marker, deps.now())) {
			await save({ ...marker, stage: "verified" })
		}

		if (marker.stage !== "verified" || marker.wiped) {
			return
		}

		await deps.wipeLegacy()
		await save({ ...marker, wiped: true })
		deps.info("migration: the old client's secrets were wiped")
	}

	function wipeInBackground(): void {
		void serial(wipeIfDue).catch((error: unknown) => {
			deps.warn(`migration: wipe failed: ${errorCode(error)}`)
		})
	}

	return {
		start: async () => {
			let result: MigrationResult = { pinImported: false }

			try {
				marker = parseMarker((await deps.marker.read())?.toString("utf8") ?? null)

				if (marker?.wiped === true) {
					if (!marker.purged) {
						await deps.purgeLegacyStores()
						await save({ ...marker, purged: true })
						deps.info("migration: the old client's stores were deleted from disk")
					}

					return result
				}

				// Every launch after it finished: one small file read.
				if (marker?.stage === "skipped") {
					return result
				}

				if (marker === null || marker.stage === "started") {
					const legacyProfile = marker !== null || (await deps.legacyProfile())
					const vault = legacyProfile ? (await deps.vault.get()).status : "absent"
					const decision = startupDecision(marker, legacyProfile, vault)

					if (decision === "defer") {
						deps.info("migration: deferred (the session vault cannot be read)")

						return result
					}

					if (decision !== "run") {
						deps.info(`migration: ${decision}`)
						await save({ ...(marker ?? fresh("skipped")), stage: "skipped" })

						return result
					}

					result = await attempt(marker)
				}
			} catch (error) {
				deps.warn(`migration: failed: ${errorCode(error)}`)

				return result
			}

			wipeInBackground()

			return result
		},
		sessionConfirmed: async sessionBlob => {
			if (marker === null || !verifiedBy(marker, sessionBlob)) {
				return
			}

			await serial(async () => {
				if (marker !== null && verifiedBy(marker, sessionBlob)) {
					await save({ ...marker, stage: "verified" })
					deps.info("migration: the imported account is verified")
				}
			}).catch((error: unknown) => {
				deps.warn(`migration: verification not recorded: ${errorCode(error)}`)
			})

			wipeInBackground()
		}
	}
}
