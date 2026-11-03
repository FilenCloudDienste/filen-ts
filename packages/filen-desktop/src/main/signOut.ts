import { rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { type } from "arktype"
import { type AtomicFile, errorCode } from "./atomicFile.ts"
import { serialQueue } from "../shared/serial.ts"

// A sign-out takes the signed-out user's local data with the session: the sync engine's state (`sync-engine/<userId>`:
// the baseline and cache databases name every synced file, shell.json holds the pairs), the network drive and servers
// (`mounts/<userId>`: their config and credentials, rclone's cache and state), the old client's stash (its pairs and
// mounts not imported yet), the app lock's PIN record and, last, the shell's logs. The files go once the native host
// has exited, so nothing holds them open. A drive cache that may still hold files not uploaded yet keeps its whole
// directory: they upload at the user's next sign-in. The browser profile (the page's storage, cookies and caches) is
// deleted on the next launch, before ready, when Chromium holds none of it open and the page cannot race it. Whatever
// cannot be deleted (a file Windows keeps open past the retries) is listed in a marker and deleted on the next start,
// before anything reads it.

export type WipePart = "sync" | "mounts"

// What a sign-out deletes once, whoever signed out: the stash, the PIN record, the logs and the browser profile.
type Global = "stash" | "lock" | "logs" | "profile"

const GLOBALS: readonly Global[] = ["stash", "lock", "logs", "profile"]

export interface SignOutSteps {
	// Filen in Finder goes for the user (null: not known).
	fileProvider(userId: string | null): Promise<void>
	// Stops rclone's drive and servers; true when no upload is left in the drive's cache, so its directory may go.
	mounts(userId: string): Promise<boolean>
	// Stops the native host (watches, the engine, rclone) and settles once it exited.
	stopHost(): Promise<void>
	// Drops what main holds in memory of the user's `parts`, before their files go.
	forget(userId: string, parts: readonly WipePart[]): void
	// Ends the old client's import (nothing more is read from it) and deletes its stash, in memory too.
	discardStash(): Promise<void>
	// Removes the PIN record and unlocks, in memory too.
	resetLock(): Promise<void>
	// Deletes the shell's logs directory (main.log, rclone.log) through the file log, which starts a new one.
	clearLogs(): Promise<void>
}

export type ProfileOutcome =
	| { result: "not-due" }
	| { result: "deleted" }
	// A session is stored again: the profile is the new session's.
	| { result: "signed-in" }
	| { result: "failed"; code: string }

export interface SignOutDeps {
	steps: SignOutSteps
	// `<userData>/sync-engine` and `<userData>/mounts`: a user's directory is `<root>/<userId>`.
	syncRoot: string
	mountsRoot: string
	// The PIN record, removed directly on a start (before the app lock reads it).
	lockFile: string
	marker: AtomicFile
	remove(target: string): Promise<void>
	// What wipeProfileBeforeReady did in this launch.
	profile(): ProfileOutcome
	log: { info(message: string): void; warn(message: string): void }
}

export interface SignOut {
	// Deletes what an earlier sign-out left and records what wipeProfileBeforeReady did. Before the app lock, the
	// migration, the sync and the mounts stores read anything. Never rejects.
	resume(): Promise<void>
	// Before the session leaves the vault: the browser profile is listed, so a sign-out cut short after that has it
	// deleted on the next launch (unless a session is stored again), and with it everything the page's own flag would
	// finish, which the migration's purge of Local Storage may delete. Never rejects.
	begin(): Promise<void>
	// After the session left the vault. Never rejects.
	signOut(userId: string | null): Promise<void>
	// A sign-in as `userId`: what is left of an earlier sign-out is deleted now or kept for good, so that no later start
	// deletes what the new session writes. Never rejects.
	signedIn(userId: string): Promise<void>
}

// Node retries EBUSY, EPERM, EMFILE, ENFILE and ENOTEMPTY with a linear backoff: about 3 s in all.
const REMOVE_RETRIES = 5
const REMOVE_RETRY_DELAY_MS = 200

export function removeTree(target: string): Promise<void> {
	return rm(target, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS })
}

// The default session's storage in userData, every origin's: the page's localStorage, sessionStorage, IndexedDB,
// OPFS (File System), service workers with their Cache Storage, storage buckets (WebStorage), cookies, and the HTTP,
// code, GPU and WebGPU caches. LevelDB and SQLite keep deleted values on disk until a compaction, so the files go, not
// the entries. Chromium's own state (Local State, Preferences, spellcheck dictionaries) and the app's files stay.
export const PROFILE_ENTRIES: readonly string[] = [
	"Local Storage",
	"Session Storage",
	"IndexedDB",
	"File System",
	"Service Worker",
	"WebStorage",
	"Shared Dictionary",
	"SharedStorage",
	"SharedStorage-wal",
	"blob_storage",
	"Cookies",
	"Cookies-journal",
	path.join("Network", "Cookies"),
	path.join("Network", "Cookies-journal"),
	path.join("Network", "Trust Tokens"),
	path.join("Network", "Trust Tokens-journal"),
	"Cache",
	"Code Cache",
	"GPUCache",
	"DawnCache",
	"DawnGraphiteCache",
	"DawnWebGPUCache"
]

function removeTreeSync(target: string): void {
	rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

// Deletes every PROFILE_ENTRIES entry it can, synchronously; throws the first failure once all were tried.
export function deleteProfileStorage(userData: string, remove: (target: string) => void = removeTreeSync): void {
	let failure: unknown = null

	for (const entry of PROFILE_ENTRIES) {
		try {
			remove(path.join(userData, entry))
		} catch (error) {
			failure ??= error
		}
	}

	if (failure !== null) {
		throw failure
	}
}

export interface ProfileWipeDeps {
	// The marker's text, null when it is absent.
	readMarker(): string | null
	// The session vault file exists.
	sessionStored(): boolean
	// deleteProfileStorage.
	deleteProfile(): void
}

// The browser profile of a sign-out, deleted before ready: Chromium opens these stores once the default session
// exists, and Windows refuses to delete open files (EBUSY), so this runs synchronously after the single-instance lock.
// The page's own sign-out wipe has run (its flag that finishes one cut short lives in Local Storage, and everything it
// would finish is in what goes here). A session stored since (a sign-in after the sign-out, in a run that ended before
// it was recorded) keeps the profile: it is the new session's. `resume` records the outcome.
export function wipeProfileBeforeReady(deps: ProfileWipeDeps): ProfileOutcome {
	let read: Pending | null

	try {
		const text = deps.readMarker()

		read = text === null ? null : parsePending(text)
	} catch {
		// `resume` reads the marker again and logs the failure.
		return { result: "not-due" }
	}

	if (read?.globals.has("profile") !== true) {
		return { result: "not-due" }
	}

	if (deps.sessionStored()) {
		return { result: "signed-in" }
	}

	try {
		deps.deleteProfile()
	} catch (error) {
		return { result: "failed", code: errorCode(error) }
	}

	return { result: "deleted" }
}

// Names a directory under userData, so only a plain user id is ever joined to a path.
const userIdSchema = type(/^[1-9][0-9]{0,19}$/)

const markerSchema = type({
	version: "1",
	users: type({ "[string]": type("'sync' | 'mounts'").array() }),
	lock: "boolean",
	"stash?": "boolean",
	"logs?": "boolean",
	"profile?": "boolean",
	"+": "delete"
})

interface Pending {
	users: Map<string, Set<WipePart>>
	globals: Set<Global>
}

const LABELS: Record<WipePart | Global, string> = {
	sync: "sync data",
	mounts: "network drive data",
	stash: "old client's stash",
	lock: "app lock",
	logs: "logs",
	profile: "browser profile"
}

function parsePending(text: string): Pending | null {
	let json: unknown

	try {
		json = JSON.parse(text)
	} catch {
		return null
	}

	const marker = markerSchema(json)

	if (marker instanceof type.errors) {
		return null
	}

	const users = new Map<string, Set<WipePart>>()

	for (const [userId, parts] of Object.entries(marker.users)) {
		if (!(userIdSchema(userId) instanceof type.errors) && parts.length > 0) {
			users.set(userId, new Set(parts))
		}
	}

	return { users, globals: new Set(GLOBALS.filter(entry => marker[entry] === true)) }
}

export function createSignOut(deps: SignOutDeps): SignOut {
	const { steps, log } = deps
	const serial = serialQueue()
	const pending: Pending = { users: new Map(), globals: new Set() }
	// The marker file exists (or may: a removal that failed).
	let stored = false

	function directory(userId: string, part: WipePart): string {
		return path.join(part === "sync" ? deps.syncRoot : deps.mountsRoot, userId)
	}

	// Writes what is pending, or removes the marker once nothing is.
	async function save(): Promise<void> {
		try {
			if (pending.users.size === 0 && pending.globals.size === 0) {
				if (stored) {
					await deps.marker.remove()
					stored = false
				}

				return
			}

			const users = Object.fromEntries([...pending.users].map(([userId, parts]) => [userId, [...parts]]))
			const globals = Object.fromEntries(GLOBALS.map(entry => [entry, pending.globals.has(entry)]))

			stored = true
			await deps.marker.write(Buffer.from(JSON.stringify({ version: 1, users, ...globals })))
		} catch (error) {
			log.warn(`sign-out: wipe marker not saved: ${errorCode(error)}`)
		}
	}

	// Deletes the user's `part`; true once it is gone.
	async function removePart(userId: string, part: WipePart, when: string): Promise<boolean> {
		try {
			await deps.remove(directory(userId, part))
		} catch (error) {
			log.warn(`sign-out: ${LABELS[part]} not deleted ${when}: ${errorCode(error)}`)

			return false
		}

		const parts = pending.users.get(userId)

		parts?.delete(part)

		if (parts?.size === 0) {
			pending.users.delete(userId)
		}

		return true
	}

	// Runs the step of `entry`; true once it is done (and no longer pending).
	async function clear(entry: Global, when: string, operation: () => Promise<void>): Promise<boolean> {
		try {
			await operation()
		} catch (error) {
			log.warn(`sign-out: ${LABELS[entry]} not deleted ${when}: ${errorCode(error)}`)

			return false
		}

		pending.globals.delete(entry)

		return true
	}

	// A step that failed is logged and the sign-out goes on; undefined then.
	async function attempt<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
		try {
			return await operation()
		} catch (error) {
			log.warn(`sign-out: ${label} failed: ${errorCode(error)}`)

			return undefined
		}
	}

	async function run(userId: string | null): Promise<void> {
		const user = userId !== null && !(userIdSchema(userId) instanceof type.errors) ? userId : null

		await attempt("file provider", () => steps.fileProvider(user))

		const mountsCleared = user !== null && (await attempt("mounts", () => steps.mounts(user))) === true

		await attempt("host stop", steps.stopHost)

		const parts: WipePart[] = user === null ? [] : mountsCleared ? ["sync", "mounts"] : ["sync"]

		// Replaces anything listed for the user before: a mounts directory kept now is never deleted later.
		if (user !== null) {
			pending.users.set(user, new Set(parts))
			steps.forget(user, parts)
		}

		for (const entry of GLOBALS) {
			pending.globals.add(entry)
		}

		// Listed before anything is deleted, so a sign-out cut short finishes on the next start.
		await save()

		const when = "on sign-out, tried again next start"

		if (user !== null) {
			for (const part of parts) {
				if (await removePart(user, part, when)) {
					log.info(`sign-out: ${LABELS[part]} deleted`)
				}
			}

			if (!mountsCleared) {
				log.info(`sign-out: ${LABELS.mounts} kept for the uploads its cache may hold`)
			}
		}

		if (await clear("stash", when, steps.discardStash)) {
			log.info(`sign-out: ${LABELS.stash} deleted`)
		}

		if (await clear("lock", when, steps.resetLock)) {
			log.info(`sign-out: ${LABELS.lock} removed`)
		}

		log.info(`sign-out: the ${LABELS.profile} is deleted on the next launch`)
		// Last: what the wipe logged goes with them.
		await clear("logs", when, steps.clearLogs)
		await save()
	}

	// The profile as wipeProfileBeforeReady left it: done, kept for a stored session, or tried again next launch.
	function recordProfile(): void {
		if (!pending.globals.has("profile")) {
			return
		}

		const outcome = deps.profile()

		if (outcome.result === "deleted") {
			pending.globals.delete("profile")
			log.info(`sign-out: ${LABELS.profile} deleted`)
		} else if (outcome.result === "signed-in") {
			pending.globals.delete("profile")
			log.info(`sign-out: ${LABELS.profile} kept, a session is stored again`)
		} else if (outcome.result === "failed") {
			log.warn(`sign-out: ${LABELS.profile} not deleted, tried again next launch: ${outcome.code}`)
		}
	}

	async function resume(): Promise<void> {
		let data: Buffer | null

		try {
			data = await deps.marker.read()
		} catch (error) {
			log.warn(`sign-out: wipe marker unreadable: ${errorCode(error)}`)

			return
		}

		if (data === null) {
			return
		}

		stored = true

		const read = parsePending(data.toString("utf8"))

		if (read === null) {
			log.warn("sign-out: wipe marker is invalid; dropped")
			await save()

			return
		}

		for (const [userId, parts] of read.users) {
			pending.users.set(userId, parts)
		}

		for (const entry of read.globals) {
			pending.globals.add(entry)
		}

		const when = "after a sign-out, tried again next start"

		for (const [userId, parts] of [...pending.users]) {
			for (const part of [...parts]) {
				if (await removePart(userId, part, when)) {
					log.info(`sign-out: ${LABELS[part]} left by a sign-out deleted`)
				}
			}
		}

		if (pending.globals.has("stash") && (await clear("stash", when, steps.discardStash))) {
			log.info(`sign-out: ${LABELS.stash} left by a sign-out deleted`)
		}

		// Before the app lock is loaded: its file directly.
		if (pending.globals.has("lock") && (await clear("lock", when, () => deps.remove(deps.lockFile)))) {
			log.info(`sign-out: ${LABELS.lock} left by a sign-out removed`)
		}

		recordProfile()

		// Last, so the lines above go with them.
		if (pending.globals.has("logs")) {
			await clear("logs", when, steps.clearLogs)
		}

		await save()
	}

	async function signedIn(userId: string): Promise<void> {
		const parts = pending.users.get(userId)

		if (parts === undefined && pending.globals.size === 0) {
			return
		}

		const when = "before a sign-in, kept"

		if (parts !== undefined) {
			steps.forget(userId, [...parts])

			for (const part of [...parts]) {
				await removePart(userId, part, when)
			}

			pending.users.delete(userId)
		}

		// The stash is never written again, so one still there is deleted later all the same.
		if (pending.globals.has("stash")) {
			await clear("stash", "before a sign-in, tried again next start", steps.discardStash)
		}

		if (pending.globals.has("lock")) {
			await clear("lock", when, steps.resetLock)
			pending.globals.delete("lock")
		}

		// The profile and the logs are the new session's from now on.
		if (pending.globals.delete("profile")) {
			log.info(`sign-out: ${LABELS.profile} kept, signed in again before a launch`)
		}

		if (pending.globals.has("logs")) {
			await clear("logs", when, steps.clearLogs)
			pending.globals.delete("logs")
		}

		await save()
	}

	return {
		resume: () =>
			serial(resume).catch((error: unknown) => {
				log.warn(`sign-out: leftovers not deleted: ${errorCode(error)}`)
			}),
		begin: () =>
			serial(async () => {
				if (!pending.globals.has("profile")) {
					pending.globals.add("profile")
					await save()
				}
			}).catch((error: unknown) => {
				log.warn(`sign-out: start not recorded: ${errorCode(error)}`)
			}),
		signOut: userId =>
			serial(() => run(userId)).catch((error: unknown) => {
				log.warn(`sign-out: wipe failed: ${errorCode(error)}`)
			}),
		signedIn: userId =>
			serial(() => signedIn(userId)).catch((error: unknown) => {
				log.warn(`sign-out: leftovers before a sign-in failed: ${errorCode(error)}`)
			})
	}
}
