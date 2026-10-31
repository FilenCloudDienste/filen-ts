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
//             the stash again, until the wait for the wipe ran out
//   imported  session, PIN, prefs and the stash are stored (only the stash when `stashOnly`); the old origin still
//             holds its plaintext secrets
//   abandoned the read failed too often; nothing is imported, the old secrets are still wiped once the wait ran out
//   verified  the migrated account proved itself (an authed request, a sign-in as the same user) or the wait ran out;
//             the old secrets are wiped, `wiped` says whether that finished; LevelDB keeps deleted values on disk
//             until a compaction that may never come, so a later launch deletes the old origin's stores before
//             anything opens them, and `purged` records that
//   skipped   nothing to import (a fresh install)
// The old client's rclone config (the account's keys, merely obscured) is deleted once the import is done or given up.
export type MigrationStage = "started" | "imported" | "abandoned" | "verified" | "skipped"

export interface MigrationMarker {
	stage: MigrationStage
	failedStarts: number
	// When the first attempt began (null: before it, or a marker older than the field).
	startedAt: number | null
	// The vault held a session before the first attempt (signed in to this app already), or an earlier attempt imported
	// them already: the session, PIN and prefs the user has here are left alone and only the stash is imported.
	stashOnly: boolean
	// The stash could not be stored (no secure storage): it is read again on every launch.
	volatileStash: boolean
	// The old signed-in account, once imported (null: it had none).
	userId: number | null
	importedAt: number | null
	wiped: boolean
	purged: boolean
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
		startedAt: marker.startedAt ?? null,
		stashOnly: marker.stashOnly ?? false,
		volatileStash: marker.volatileStash ?? false,
		userId: marker.userId,
		importedAt: marker.importedAt,
		wiped: marker.wiped,
		purged: marker.purged ?? false
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
	// Nothing written: the vault cannot be read right now (a keychain locked at login), so ask again next launch.
	| "defer"
	| "skip-fresh"
	// Too many failed attempts: no more reads, the old secrets are wiped once the wait ran out.
	| "abandon"
	| "none"

// Whether this launch imports. Only a launch with no marker can see a session the user stored in 4.x itself, so that
// is where a stored session limits it to the stash (a newer sign-in, its PIN and prefs are never overwritten); the
// marker keeps that for reruns. A rerun after a crash imports again but leaves a session the earlier attempt already
// stored alone.
export function startupDecision(marker: MigrationMarker | null, legacyProfile: boolean, vault: SessionRead["status"]): StartupDecision {
	if (marker === null) {
		if (!legacyProfile) {
			return "skip-fresh"
		}

		if (vault === "present") {
			return "stash"
		}

		return vault === "unreadable" ? "defer" : "run"
	}

	if (marker.stage !== "started") {
		return "none"
	}

	// A read that worked resets the count, so only failed reads in a row give up.
	if (marker.failedStarts >= MAX_FAILED_STARTS) {
		return "abandon"
	}

	if (marker.stashOnly) {
		return "stash"
	}

	return vault === "unreadable" ? "defer" : "run"
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

export interface MigrationDeps {
	marker: AtomicFile
	// The old profile's localStorage exists (a cheap check of its directory).
	legacyProfile(): Promise<boolean>
	// READ_SCRIPT's result from the old origin; rejects on a timeout or a failed load.
	readLegacy(): Promise<unknown>
	// The old options.v1.json, null when absent.
	readOptions(): Promise<string | null>
	// Runs WIPE_SCRIPT in the old origin; rejects unless all of it worked.
	wipeLegacy(): Promise<void>
	// Deletes the old client's rclone config; nothing when it is gone already.
	removeRcloneConfig(): Promise<void>
	// Deletes the old origin's IndexedDB and the Local Storage store on disk. Only called before any window or storage
	// use in this launch, and only with a session in the vault (see `purge`); the new page loses its few localStorage
	// values (theme choice, splash hint) once.
	purgeLegacyStores(): Promise<void>
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

// Runs one step; a failure is rethrown as the step and the original's code or name, never its message (which may
// carry data). safeStorage rejects with a plain Error whose message is the reason: those log as `uncoded` instead.
async function step<T>(name: MigrationStep, run: () => T | Promise<T>, uncoded?: string): Promise<T> {
	try {
		return await run()
	} catch (error) {
		const code = errorCode(error)

		throw stepError(name, code === "Error" && uncoded !== undefined ? uncoded : code)
	}
}

// The cause of a step that encrypts with safeStorage and fails without a code.
const SAFE_STORAGE = "safeStorage"

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
			userId: null,
			importedAt: null,
			wiped: false,
			purged: false
		}
	}

	// Once the import is done or given up; a failure is tried again by the wipe.
	async function removeRcloneConfig(): Promise<void> {
		await deps.removeRcloneConfig().catch((error: unknown) => {
			deps.warn(`migration: the old rclone config was not deleted: ${errorCode(error)}`)
		})
	}

	// Errors are logged by their step and code only: none of this may ever log a value.
	async function attempt(previous: MigrationMarker | null, stashOnly: boolean): Promise<MigrationResult> {
		await save({
			...(previous ?? fresh("started")),
			stage: "started",
			failedStarts: (previous?.failedStarts ?? 0) + 1,
			startedAt: previous?.startedAt ?? deps.now(),
			stashOnly
		})

		const read = parseReadResult(await step("legacy read", () => deps.readLegacy()))

		if (read === null) {
			throw stepError("legacy parse", "unexpected read result")
		}

		deps.info(`migration: read keys=${String(read.count)}`)

		// The old web app wrote its defaults on first start, so a profile that has run holds keys: none means the read
		// missed the origin. Tried again next launch; nothing is cleared.
		if (read.count === 0) {
			throw stepError("legacy parse", "no keys")
		}

		const { snapshot } = read
		const session = await step("legacy parse", () => legacySession(snapshot))

		if (stashOnly) {
			deps.info("migration: signed in here already; importing the stash only")
		} else {
			await importSession(session)
		}

		const userId = session.ok ? session.userId : null
		const persisted = await step(
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
			SAFE_STORAGE
		)

		const pinImported = stashOnly ? false : await importSettings(snapshot, session.ok)

		await removeRcloneConfig()

		const current = marker ?? fresh("started")
		const startedAt = current.startedAt ?? deps.now()

		// The stash lives in this run only: read again next launch (the rest is imported), until the wait ran out.
		if (!persisted && deps.now() - startedAt < WIPE_AFTER_MS) {
			await save({ ...current, failedStarts: 0, stashOnly: true, volatileStash: true, userId })
			deps.info("migration: no secure storage; the stash is read again next launch")

			return { pinImported }
		}

		await save({ ...current, stage: "imported", volatileStash: false, userId, importedAt: deps.now() })

		return { pinImported }
	}

	async function importSession(session: LegacySession): Promise<void> {
		const stored = await vaultStatus()

		if (stored === "unreadable") {
			throw stepError("vault status", "unreadable")
		}

		if (!session.ok) {
			deps.info(`migration: no session imported (${session.reason})`)
		} else if (stored === "present") {
			deps.info("migration: a session is stored already; keeping it")
		} else {
			await step("session import", () => deps.vault.set(session.blob), SAFE_STORAGE)
			deps.info("migration: session imported")
		}
	}

	// The PIN (only with the imported account) and the prefs; whether a PIN was imported.
	async function importSettings(snapshot: LegacySnapshot, signedIn: boolean): Promise<boolean> {
		let pinImported = false
		const pin = signedIn ? legacyPin(snapshot) : null

		if (pin !== null && !deps.lock.enabled()) {
			pinImported = await step("pin import", () => deps.lock.set(pin), SAFE_STORAGE)
			deps.info(pinImported ? "migration: app lock PIN imported" : "migration: app lock PIN not imported")
		}

		const launchAtLogin = await step("prefs import", async () => {
			const prefs = legacyPrefs(snapshot, await deps.readOptions())
			const launches = deps.launchesAtLogin()

			if (Object.keys(prefs).length > 0 || launches) {
				await deps.prefs.set(launches ? { ...prefs, launchAtLogin: launches } : prefs)
				deps.info("migration: preferences imported")
			}

			return launches
		})

		// Registered again in this app's form; the setting is kept even if that fails.
		if (launchAtLogin) {
			await deps.applyLaunchAtLogin(true).catch((error: unknown) => {
				deps.warn(`migration: launch at login not re-registered: ${errorCode(error)}`)
			})
		}

		return pinImported
	}

	// LevelDB keeps deleted values until a compaction, so the stores go once the secrets are wiped. Deleting the Local
	// Storage store also deletes the page's own flag that finishes a sign-out cut short (filen-web signOutPending.ts),
	// whose loss would leave the signed-out account's local data behind. That flag can outlive the session only:
	// sign-out clears the vault first among its wipes, and a stored session means the user is signed in (or the
	// sign-out stopped before clearing anything, which the page then shows as still signed in). So the purge waits for
	// a launch with a session in the vault; a vault kept in memory only never has one, and keeps the stores.
	async function purge(current: MigrationMarker): Promise<void> {
		if ((await vaultStatus()) !== "present") {
			deps.info("migration: deleting the old stores waits for a launch with a stored session")

			return
		}

		try {
			await deps.purgeLegacyStores()
		} catch (error) {
			// Windows: a file held open (EBUSY, EPERM) by a scanner or indexer.
			deps.warn(`migration: deleting the old stores failed, tried again next launch: ${errorCode(error)}`)

			return
		}

		await save({ ...current, purged: true })
		deps.info("migration: the old client's stores were deleted from disk")
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
						await purge(marker)
					}

					return result
				}

				// Every launch after it finished: one small file read.
				if (marker?.stage === "skipped") {
					return result
				}

				if (marker === null || marker.stage === "started") {
					const legacyProfile = marker !== null || (await step("profile probe", () => deps.legacyProfile()))
					const vault = legacyProfile ? await vaultStatus() : "absent"
					const decision = startupDecision(marker, legacyProfile, vault)

					if (decision === "defer") {
						deps.info("migration: deferred (the session vault cannot be read)")

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
						result = await attempt(marker, decision === "stash")
					}
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
			})
	}
}
