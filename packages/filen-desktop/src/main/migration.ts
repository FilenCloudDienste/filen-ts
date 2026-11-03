import path from "node:path"
import { type } from "arktype"
import type { SessionRead } from "../shared/channels.ts"
import { type AtomicFile, codedError, errorCode } from "./atomicFile.ts"
import {
	effectiveConfig,
	LEGACY_FEATURES,
	type LegacyFeature,
	legacyPin,
	legacyPrefs,
	type LegacyPrefs,
	legacySession,
	type LegacySession,
	type LegacySnapshot,
	legacyStash,
	type LegacyStash,
	parseReadResult,
	parseStash
} from "./legacyData.ts"
import { serialQueue } from "../shared/serial.ts"
import { sessionUserId, type VaultCipher } from "./sessionVault.ts"

// The one-time import from the old client (3.0.53), PLAN §6 steps 1-5 and 8. A marker file in userData records where
// it got to:
//   started   a read began; `failedStarts` counts the attempts that never reached `imported`. Without secure storage
//             (`volatileStash`) a read that worked stays here: its stash lives in memory only, so every launch reads
//             the stash again, until the wait for the wipe ran out. An attempt the keychain stopped (`deferred` while
//             the session is not decided yet) stays here too, uncounted, and is tried again next launch; the prefs go
//             first, once (`prefsImported`), so they never wait for the keychain
//   imported  session, PIN, prefs and the stash are stored (only the stash when `stashOnly`); the old origin still
//             holds its plaintext secrets
//   abandoned the read failed too often; nothing is imported, the old secrets are still wiped once the wait ran out
//   verified  the migrated account proved itself (an authed request, a sign-in as the same user) or the wait ran out;
//             the old secrets are wiped, `wiped` says whether that finished; LevelDB keeps deleted values on disk
//             until a compaction that may never come, so a later launch deletes the old origin's stores before
//             anything opens them, and `purged` records that; the old client's logs directory goes after the wipe,
//             and `logsDeleted` records that
//   skipped   nothing to import: the old client's web app never ran here (a fresh install)
// The old client's rclone config (the account's keys, merely obscured) is deleted once the import is done or given up.
export type MigrationStage = "started" | "imported" | "abandoned" | "verified" | "skipped"

export interface MigrationMarker {
	stage: MigrationStage
	failedStarts: number
	// When the first attempt began (null: before it, or a marker older than the field).
	startedAt: number | null
	// The vault held a session before an attempt decided it (signed in to this app already), or an earlier attempt imported
	// them already: the session, PIN and prefs the user has here are left alone and only the stash is imported.
	stashOnly: boolean
	// The stash could not be stored (no secure storage): it is read again on every launch.
	volatileStash: boolean
	// The keychain stopped an attempt before the session was decided: the next launch decides it like a first one.
	deferred: boolean
	// The prefs (and launch at login) were imported: never again, so a later attempt keeps what the user set since.
	prefsImported: boolean
	// The old signed-in account, once imported (null: it had none).
	userId: number | null
	importedAt: number | null
	wiped: boolean
	purged: boolean
	logsDeleted: boolean
}

// A read that crashed or came back empty this many times is not tried again.
export const MAX_FAILED_STARTS = 3

// The old origin's secrets are wiped at the latest this long after the import, verified or not (offline, an account
// whose session the server no longer takes), or after the first attempt of an import that was given up.
export const WIPE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const markerSchema = type({
	version: "1",
	stage: "'started' | 'imported' | 'abandoned' | 'verified' | 'skipped'",
	failedStarts: "0 <= number.integer < 1000",
	"startedAt?": type("number.integer >= 0").or("null"),
	"stashOnly?": "boolean",
	"volatileStash?": "boolean",
	"deferred?": "boolean",
	"prefsImported?": "boolean",
	userId: type("1 < number.integer <= 9007199254740991").or("null"),
	importedAt: type("number.integer >= 0").or("null"),
	wiped: "boolean",
	"purged?": "boolean",
	"logsDeleted?": "boolean"
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
		startedAt: marker.startedAt ?? null,
		stashOnly: marker.stashOnly ?? false,
		volatileStash: marker.volatileStash ?? false,
		deferred: marker.deferred ?? false,
		prefsImported: marker.prefsImported ?? false,
		userId: marker.userId,
		importedAt: marker.importedAt,
		wiped: marker.wiped,
		purged: marker.purged ?? false,
		logsDeleted: marker.logsDeleted ?? false
	}
}

export function serializeMarker(marker: MigrationMarker): string {
	return JSON.stringify({ version: 1, ...marker })
}

// The old client's signed-in account, whose uploads its rclone caches hold: null when it had none (or nothing was
// imported), undefined while the import has not got that far.
export function legacyOwner(marker: MigrationMarker | null): string | null | undefined {
	switch (marker?.stage) {
		case "started":
			if (!marker.volatileStash) {
				return undefined
			}

			return marker.userId === null ? null : String(marker.userId)
		case "imported":
		case "verified":
			return marker.userId === null ? null : String(marker.userId)
		case "abandoned":
		case "skipped":
			return null
		default:
			return undefined
	}
}

export type StartupDecision =
	| "run"
	// Imports the stash only: the user is signed in to this app already.
	| "stash"
	// The vault cannot be read right now (a keychain locked at login or denied): only the prefs are imported, once,
	// and the rest is asked again next launch, uncounted.
	| "defer"
	| "skip-fresh"
	// Too many failed attempts: no more reads, the old secrets are wiped once the wait ran out.
	| "abandon"
	| "none"

// Whether this launch imports. Without the old profile there is nothing to import, also for an attempt an earlier
// build started on a fresh install (its read found no keys). Only a launch before any attempt decided the session (no
// marker, or one the keychain deferred) can see a session the user stored in 4.x itself, so that is where a stored
// session limits it to the stash (a newer sign-in, its PIN and prefs are never overwritten); the marker keeps that for
// reruns. A rerun after a crash imports again but leaves a session the earlier attempt already stored alone.
export function startupDecision(marker: MigrationMarker | null, legacyProfile: boolean, vault: SessionRead["status"]): StartupDecision {
	if (marker !== null && marker.stage !== "started") {
		return "none"
	}

	if (!legacyProfile) {
		return "skip-fresh"
	}

	if (marker !== null) {
		// A read that worked resets the count, so only failed reads in a row give up.
		if (marker.failedStarts >= MAX_FAILED_STARTS) {
			return "abandon"
		}

		if (marker.stashOnly) {
			return "stash"
		}
	}

	if (vault === "unreadable") {
		return "defer"
	}

	return vault === "present" && (marker === null || marker.deferred) ? "stash" : "run"
}

// Whether the wipe stops waiting for verification: at once after an import without an account (nothing to verify),
// else once the time limit passed since the import, or since the first attempt of one given up. A clock set back
// counts from now.
export function waitExpired(marker: MigrationMarker, now: number): boolean {
	if (marker.stage === "abandoned") {
		return now - (marker.startedAt ?? now) >= WIPE_AFTER_MS
	}

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

// The old client's logs directory (desktop.log, desktop-worker.log, rclone-*.log, sync.log): `<appData>/@filen/logs`,
// beside its userData, which this app shares.
export function legacyLogsDir(userData: string): string {
	return path.join(path.dirname(userData), "logs")
}

export type PurgeOutcome = { result: "not-due" } | { result: "deleted" } | { result: "failed"; code: string }

export interface PurgeDeps {
	// The marker file's text, null when it is absent.
	readMarker(): string | null
	// The session vault file exists.
	sessionStored(): boolean
	// Deletes the old origin's IndexedDB and the Local Storage store; throws when an entry stays.
	deleteStores(): void
	// Deletes the browser profile's storage (signOut.ts deleteProfileStorage), the old origin's stores among it.
	deleteProfile(): void
}

// LevelDB keeps deleted values until a compaction, so the old origin's stores are deleted from disk once its secrets
// are wiped. Chromium opens the profile's Local Storage store once the default session exists, and Windows refuses to
// delete open files (EBUSY), so this runs synchronously before ready, after the single-instance lock; `start` records
// the outcome. The new page loses its few localStorage values (theme choice, splash hint) once.
// Deleting the Local Storage store also deletes the page's own flag that finishes a sign-out cut short (filen-web
// signOutPending.ts), whose loss would leave the signed-out account's local data behind. That flag can outlive the
// session only: sign-out clears the vault first among its wipes, removing its file (in memory-only mode too), and an
// existing file means a stored session (or a sign-out that stopped before clearing anything, which the page then shows
// as still signed in). Without the vault file (signed out, or no secure storage to store a session in) the flag may be
// set, so the whole profile goes, as after a sign-out: everything the flag would finish goes with it.
export function purgeBeforeReady(deps: PurgeDeps): PurgeOutcome {
	let current: MigrationMarker | null

	try {
		current = parseMarker(deps.readMarker())
	} catch {
		// `start` reads the marker again and logs the failure.
		return { result: "not-due" }
	}

	if (current?.wiped !== true || current.purged) {
		return { result: "not-due" }
	}

	try {
		if (deps.sessionStored()) {
			deps.deleteStores()
		} else {
			deps.deleteProfile()
		}
	} catch (error) {
		return { result: "failed", code: errorCode(error) }
	}

	return { result: "deleted" }
}

export interface MigrationDeps {
	marker: AtomicFile
	// The old client's web app ran in this profile (a cheap check of its IndexedDB directory, legacyProfileExists).
	legacyProfile(): Promise<boolean>
	// READ_SCRIPT's result from the old origin; rejects on a timeout or a failed load.
	readLegacy(): Promise<unknown>
	// The old options.v1.json, null when absent.
	readOptions(): Promise<string | null>
	// Runs WIPE_SCRIPT in the old origin; rejects unless all of it worked.
	wipeLegacy(): Promise<void>
	// Deletes the old client's rclone config; nothing when it is gone already.
	removeRcloneConfig(): Promise<void>
	// Deletes the old client's logs directory (`<appData>/@filen/logs`, beside userData); nothing when it is gone.
	removeLegacyLogs(): Promise<void>
	// What purgeBeforeReady did in this launch.
	earlyPurge(): PurgeOutcome
	vault: { get(): Promise<SessionRead>; set(blob: string): Promise<void> }
	lock: { enabled(): boolean; set(pin: string): Promise<boolean> }
	prefs: { set(patch: LegacyPrefs & { launchAtLogin?: boolean }): Promise<unknown> }
	// The OS login item the old client registered.
	launchesAtLogin(): boolean
	applyLaunchAtLogin(enabled: boolean): Promise<void>
	// Encrypted like the vault; where the vault keeps the session in memory only, so is this (not written): false then.
	writeStash(text: string): Promise<boolean>
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
	// A sign-out: an import not finished yet ends, so nothing is read from the old client again, whoever signs in next
	// (a rerun would import its session, or its stash read anew). Its secrets are still wiped once the wait ran out, and
	// its rclone caches stay with its account. Rejects when the marker cannot be read or written.
	signedOut(): Promise<void>
}

// Where a migration failure happened; logged with the cause as "<step>: <cause>".
type MigrationStep =
	| "marker read"
	| "marker write"
	| "profile probe"
	| "vault status"
	| "legacy read"
	| "legacy parse"
	| "session import"
	| "stash"
	| "pin import"
	| "prefs import"
	| "rclone config"
	| "legacy wipe"

function stepError(step: MigrationStep, cause: string): Error {
	return codedError(`${step}: ${cause}`)
}

// What an attempt imports: everything, the stash only (signed in here already), or the prefs only (the vault cannot be
// read now).
type AttemptMode = "full" | "stash" | "prefs"

// The keychain stopped the attempt (safeStorage denied, locked or gone, or the vault unreadable): it is tried again
// next launch and never counts toward giving up.
class Deferral extends Error {
	readonly code: string

	constructor(step: MigrationStep, cause: string) {
		super(`${step}: ${cause}`)
		this.name = "Deferral"
		this.code = this.message
	}
}

// Runs one step; a failure is rethrown as the step and the original's code or name, never its message (which may
// carry data). safeStorage rejects with a plain Error whose message is the reason: in a step that encrypts with it
// (`keychain`) that is a Deferral.
async function step<T>(name: MigrationStep, run: () => T | Promise<T>, keychain = false): Promise<T> {
	try {
		return await run()
	} catch (error) {
		const code = errorCode(error)

		if (keychain && code === "Error") {
			throw new Deferral(name, "safeStorage")
		}

		throw stepError(name, code)
	}
}

export function createMigration(deps: MigrationDeps): Migration {
	let marker: MigrationMarker | null = null
	const serial = serialQueue()

	async function save(next: MigrationMarker): Promise<void> {
		await step("marker write", () => deps.marker.write(Buffer.from(serializeMarker(next))))
		marker = next
	}

	async function vaultStatus(): Promise<SessionRead["status"]> {
		return (await step("vault status", () => deps.vault.get())).status
	}

	function fresh(stage: MigrationStage): MigrationMarker {
		return {
			stage,
			failedStarts: 0,
			startedAt: null,
			stashOnly: false,
			volatileStash: false,
			deferred: false,
			prefsImported: false,
			userId: null,
			importedAt: null,
			wiped: false,
			purged: false,
			logsDeleted: false
		}
	}

	// Once the import is done or given up; a failure is tried again by the wipe.
	async function removeRcloneConfig(): Promise<void> {
		await deps.removeRcloneConfig().catch((error: unknown) => {
			deps.warn(`migration: the old rclone config was not deleted: ${errorCode(error)}`)
		})
	}

	// Errors are logged by their step and code only: none of this may ever log a value.
	async function attempt(previous: MigrationMarker | null, mode: AttemptMode): Promise<MigrationResult> {
		const stashOnly = mode === "stash"
		// No earlier attempt can have stored the session: only then may a deferral leave it to be decided afresh.
		const undecided = previous === null || previous.deferred

		await save({
			...(previous ?? fresh("started")),
			stage: "started",
			failedStarts: (previous?.failedStarts ?? 0) + 1,
			startedAt: previous?.startedAt ?? deps.now(),
			stashOnly,
			deferred: mode === "prefs" ? undecided : previous?.deferred === true
		})

		const read = parseReadResult(await step("legacy read", () => deps.readLegacy()))

		if (read === null) {
			throw stepError("legacy parse", "unexpected read result")
		}

		deps.info(`migration: read keys=${String(read.count)}`)

		// The old web app opened the IndexedDB the probe found as it loaded and wrote its defaults to localStorage right
		// after, so the profile holds keys: none means the read missed the origin. Tried again next launch; nothing is
		// cleared.
		if (read.count === 0) {
			throw stepError("legacy parse", "no keys")
		}

		const { snapshot } = read
		const session = await step("legacy parse", () => legacySession(snapshot))
		const userId = session.ok ? session.userId : null
		let sessionDecided = stashOnly
		let persisted: boolean
		let pinImported = false

		try {
			// Before the session, which may wait for the keychain; they need none. A failure never holds up the rest.
			if (!stashOnly && marker?.prefsImported !== true && (await importPrefs(snapshot))) {
				await save({ ...(marker ?? fresh("started")), prefsImported: true })
			}

			if (mode === "prefs") {
				throw new Deferral("vault status", "unreadable")
			}

			if (stashOnly) {
				deps.info("migration: signed in here already; importing the stash only")
			} else {
				await importSession(session)

				// Decided now: a later failure or a crash must not decide it again as a first attempt would.
				if (marker?.deferred === true) {
					await save({ ...marker, deferred: false })
				}
			}

			sessionDecided = true
			persisted = await step(
				"stash",
				async () => {
					const stash = legacyStash(snapshot, userId)

					if (stash === null) {
						return true
					}

					const stored = await deps.writeStash(JSON.stringify(stash))

					deps.info("migration: sync and mount settings stashed")

					return stored
				},
				true
			)

			// Only with the imported account, which it guarded.
			if (!stashOnly && session.ok) {
				pinImported = await importPin(snapshot)
			}
		} catch (error) {
			if (!(error instanceof Deferral)) {
				throw error
			}

			await save({
				...(marker ?? fresh("started")),
				failedStarts: previous?.failedStarts ?? 0,
				deferred: undecided && !sessionDecided
			})
			deps.warn(`migration: deferred, tried again next launch: ${error.code}`)

			return { pinImported: false }
		}

		await removeRcloneConfig()

		const current = marker ?? fresh("started")
		const startedAt = current.startedAt ?? deps.now()

		// The stash lives in this run only: read again next launch (the rest is imported), until the wait ran out.
		if (!persisted && deps.now() - startedAt < WIPE_AFTER_MS) {
			await save({ ...current, failedStarts: 0, stashOnly: true, volatileStash: true, deferred: false, userId })
			deps.info("migration: no secure storage; the stash is read again next launch")

			return { pinImported }
		}

		await save({ ...current, stage: "imported", volatileStash: false, deferred: false, userId, importedAt: deps.now() })

		return { pinImported }
	}

	async function importSession(session: LegacySession): Promise<void> {
		const stored = await vaultStatus()

		if (stored === "unreadable") {
			throw new Deferral("vault status", "unreadable")
		}

		if (!session.ok) {
			deps.info(`migration: no session imported (${session.reason})`)
		} else if (stored === "present") {
			deps.info("migration: a session is stored already; keeping it")
		} else {
			await step("session import", () => deps.vault.set(session.blob), true)
			deps.info("migration: session imported")
		}
	}

	// Whether the PIN was imported; a PIN set in this app stays.
	async function importPin(snapshot: LegacySnapshot): Promise<boolean> {
		const pin = legacyPin(snapshot)

		if (pin === null || deps.lock.enabled()) {
			return false
		}

		const imported = await step("pin import", () => deps.lock.set(pin), true)

		deps.info(imported ? "migration: app lock PIN imported" : "migration: app lock PIN not imported")

		return imported
	}

	// Whether they were imported; a failure is logged and tried again by a later attempt.
	async function importPrefs(snapshot: LegacySnapshot): Promise<boolean> {
		let launchAtLogin: boolean

		try {
			launchAtLogin = await step("prefs import", async () => {
				const prefs = legacyPrefs(snapshot, await deps.readOptions())
				const launches = deps.launchesAtLogin()

				if (Object.keys(prefs).length > 0 || launches) {
					await deps.prefs.set(launches ? { ...prefs, launchAtLogin: launches } : prefs)
					deps.info("migration: preferences imported")
				}

				return launches
			})
		} catch (error) {
			deps.warn(`migration: preferences not imported, tried again by a later attempt: ${errorCode(error)}`)

			return false
		}

		// Registered again in this app's form; the setting is kept even if that fails.
		if (launchAtLogin) {
			await deps.applyLaunchAtLogin(true).catch((error: unknown) => {
				deps.warn(`migration: launch at login not re-registered: ${errorCode(error)}`)
			})
		}

		return true
	}

	// Records what purgeBeforeReady did; `purged` is set only once the stores are gone.
	async function recordPurge(current: MigrationMarker): Promise<void> {
		const outcome = deps.earlyPurge()

		if (outcome.result === "failed") {
			// Windows: a file held open (EBUSY, EPERM) by a scanner or indexer.
			deps.warn(`migration: deleting the old stores failed, tried again next launch: ${outcome.code}`)

			return
		}

		// The marker could not be read before ready.
		if (outcome.result === "not-due") {
			deps.info("migration: deleting the old stores waits for the next launch")

			return
		}

		await save({ ...current, purged: true })
		deps.info("migration: the old client's stores were deleted from disk")
	}

	// After the wipe, until it worked once; a failure retries on the next launch. The logs name the old client's files,
	// paths and account.
	async function removeLegacyLogs(): Promise<void> {
		if (marker === null || !marker.wiped || marker.logsDeleted) {
			return
		}

		try {
			await deps.removeLegacyLogs()
		} catch (error) {
			deps.warn(`migration: deleting the old logs failed, tried again next launch: ${errorCode(error)}`)

			return
		}

		await save({ ...marker, logsDeleted: true })
		deps.info("migration: the old client's logs were deleted")
	}

	// From `verified` until the wipe worked once; a failure retries on the next confirmation or launch.
	async function wipeIfDue(): Promise<void> {
		if (marker === null) {
			return
		}

		if (waitExpired(marker, deps.now())) {
			await save({ ...marker, stage: "verified" })
		}

		if (marker.stage !== "verified" || marker.wiped) {
			return
		}

		await step("rclone config", () => deps.removeRcloneConfig())
		await step("legacy wipe", () => deps.wipeLegacy())
		await save({ ...marker, wiped: true })
		deps.info("migration: the old client's secrets were wiped")
		await removeLegacyLogs()
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
				marker = parseMarker((await step("marker read", () => deps.marker.read()))?.toString("utf8") ?? null)

				if (marker?.wiped === true) {
					if (!marker.purged) {
						await recordPurge(marker)
					}

					if (!marker.logsDeleted) {
						void serial(removeLegacyLogs).catch((error: unknown) => {
							deps.warn(`migration: deleting the old logs failed: ${errorCode(error)}`)
						})
					}

					return result
				}

				// Every launch after it finished: one small file read.
				if (marker?.stage === "skipped") {
					return result
				}

				if (marker === null || marker.stage === "started") {
					const legacyProfile = await step("profile probe", () => deps.legacyProfile())
					const vault = legacyProfile ? await vaultStatus() : "absent"
					const decision = startupDecision(marker, legacyProfile, vault)

					if (decision === "defer") {
						if (marker?.prefsImported === true) {
							deps.info("migration: deferred (the session vault cannot be read)")
						} else {
							await attempt(marker, "prefs")
						}

						return result
					}

					if (decision === "skip-fresh") {
						deps.info("migration: skip-fresh")
						await save(fresh("skipped"))

						return result
					}

					if (decision === "abandon") {
						deps.info(`migration: given up after ${String(MAX_FAILED_STARTS)} failed attempts`)
						await save({ ...(marker ?? fresh("abandoned")), stage: "abandoned", startedAt: marker?.startedAt ?? deps.now() })
						await removeRcloneConfig()
					} else if (decision === "run" || decision === "stash") {
						result = await attempt(marker, decision === "stash" ? "stash" : "full")
					}
				}
			} catch (error) {
				deps.warn(`migration: failed: ${errorCode(error)}`)

				return result
			}

			wipeInBackground()

			return result
		},
		signedOut: () =>
			serial(async () => {
				const current = marker ?? parseMarker((await step("marker read", () => deps.marker.read()))?.toString("utf8") ?? null)

				if (current === null) {
					// No attempt saved a marker yet; with nothing to import there is nothing to end.
					if (!(await step("profile probe", () => deps.legacyProfile()))) {
						return
					}

					await save({ ...fresh("abandoned"), startedAt: deps.now() })
				} else if (current.stage !== "started") {
					return
				} else if (current.volatileStash) {
					// A read worked (its stash lived in memory only): imported, for the account it read.
					await save({ ...current, stage: "imported", volatileStash: false, importedAt: deps.now() })
				} else {
					await save({ ...current, stage: "abandoned", startedAt: current.startedAt ?? deps.now() })
				}

				await removeRcloneConfig()
				deps.info(`migration: ended by a sign-out (${marker?.stage ?? "none"})`)
			}),
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

// The stash without the user's part of a feature (their own entry, and the fallback when it was theirs); null once
// nothing is left in it.
export function withoutFeature(stash: LegacyStash, userId: string, feature: LegacyFeature): LegacyStash | null {
	const { [userId]: _taken, ...others } = stash.users[feature]
	const users = { ...stash.users, [feature]: others }
	const fallback = { ...stash.fallback }

	if (stash.userId !== null && String(stash.userId) === userId) {
		delete fallback[feature]
	}

	const empty = LEGACY_FEATURES.every(entry => Object.keys(users[entry]).length === 0) && Object.keys(fallback).length === 0

	return empty ? null : { ...stash, users, fallback }
}

export interface StashStore {
	// Stores what the migration stashed; with no cipher it is kept for this run only (false).
	write(text: string): Promise<boolean>
	// The feature's old config for the user (PLAN §6 step 5), undefined when none is waiting.
	pending(userId: string, feature: LegacyFeature): Promise<unknown>
	// The user's part of the feature was applied: rewritten without it, deleted once empty.
	consume(userId: string, feature: LegacyFeature): Promise<void>
	// A sign-out: the stash goes, in memory too.
	discard(): Promise<void>
}

// The encrypted stash, decrypted once and served from memory. A stash that cannot be decrypted now (a locked keychain)
// is read again next time and never removed.
export function createStashStore(file: AtomicFile, cipher: () => Promise<VaultCipher | null>, warn: (message: string) => void): StashStore {
	// undefined: not read yet.
	let cached: LegacyStash | null | undefined
	const serial = serialQueue()

	async function load(): Promise<LegacyStash | null> {
		if (cached !== undefined) {
			return cached
		}

		const data = await file.read()
		const active = data === null ? null : await cipher()

		if (data === null || active === null) {
			cached = null

			return null
		}

		const stash = parseStash((await active.decrypt(data)).result)

		if (stash === null) {
			warn("migration: the stash is invalid; ignoring it")
		}

		cached = stash

		return stash
	}

	// False when the stash is kept for this run only.
	async function store(stash: LegacyStash | null): Promise<boolean> {
		const active = await cipher()
		let persisted = true

		if (stash === null) {
			await file.remove()
		} else if (active === null) {
			warn("migration: no secure storage; the stash is kept for this run only")
			persisted = false
		} else {
			await file.write(await active.encrypt(JSON.stringify(stash)))
		}

		cached = stash

		return persisted
	}

	return {
		write: text =>
			serial(async () => {
				const stash = parseStash(text)

				return stash === null || (await store(stash))
			}),
		pending: (userId, feature) =>
			serial(async () => {
				try {
					const stash = await load()

					return stash === null ? undefined : effectiveConfig(stash, userId, feature)
				} catch (error) {
					warn(`migration: the stash is unreadable: ${errorCode(error)}`)

					return undefined
				}
			}),
		consume: (userId, feature) =>
			serial(async () => {
				const stash = await load()

				if (stash !== null) {
					await store(withoutFeature(stash, userId, feature))
				}
			}),
		discard: () =>
			serial(async () => {
				cached = null
				await file.remove()
			})
	}
}
