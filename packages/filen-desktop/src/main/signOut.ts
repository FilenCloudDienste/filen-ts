import { rm } from "node:fs/promises"
import path from "node:path"
import { type } from "arktype"
import { type AtomicFile, errorCode } from "./atomicFile.ts"
import { serialQueue } from "../shared/serial.ts"

// A sign-out takes the signed-out user's local data with the session: the sync engine's state (`sync-engine/<userId>`:
// the baseline and cache databases name every synced file, shell.json holds the pairs), the network drive and servers
// (`mounts/<userId>`: their config and credentials, rclone's cache and state) and, last, the app lock's PIN record. The
// files go once the native host has exited, so nothing holds them open. A drive cache that may still hold files not
// uploaded yet keeps its whole directory: they upload at the user's next sign-in. Whatever cannot be deleted (a file
// Windows keeps open past the retries) is listed in a marker and deleted on the next start, before anything reads it.

export type WipePart = "sync" | "mounts"

export interface SignOutSteps {
	// Filen in Finder goes for the user (null: not known).
	fileProvider(userId: string | null): Promise<void>
	// Stops rclone's drive and servers; true when no upload is left in the drive's cache, so its directory may go.
	mounts(userId: string): Promise<boolean>
	// Stops the native host (watches, the engine, rclone) and settles once it exited.
	stopHost(): Promise<void>
	// Drops what main holds in memory of the user's `parts`, before their files go.
	forget(userId: string, parts: readonly WipePart[]): void
	// Removes the PIN record and unlocks, in memory too.
	resetLock(): Promise<void>
}

export interface SignOutDeps {
	steps: SignOutSteps
	// `<userData>/sync-engine` and `<userData>/mounts`: a user's directory is `<root>/<userId>`.
	syncRoot: string
	mountsRoot: string
	// The PIN record, removed directly on a start (before the app lock reads it).
	lockFile: string
	marker: AtomicFile
	remove(target: string): Promise<void>
	log: { info(message: string): void; warn(message: string): void }
}

export interface SignOut {
	// Deletes what an earlier sign-out left. Before the app lock, the sync and the mounts stores read anything. Never
	// rejects.
	resume(): Promise<void>
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

// Names a directory under userData, so only a plain user id is ever joined to a path.
const userIdSchema = type(/^[1-9][0-9]{0,19}$/)

const markerSchema = type({
	version: "1",
	users: type({ "[string]": type("'sync' | 'mounts'").array() }),
	lock: "boolean",
	"+": "delete"
})

interface Pending {
	users: Map<string, Set<WipePart>>
	lock: boolean
}

const LABELS: Record<WipePart | "lock", string> = { sync: "sync data", mounts: "network drive data", lock: "app lock" }

function parsePending(data: Buffer): Pending | null {
	let json: unknown

	try {
		json = JSON.parse(data.toString("utf8"))
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

	return { users, lock: marker.lock }
}

export function createSignOut(deps: SignOutDeps): SignOut {
	const { steps, log } = deps
	const serial = serialQueue()
	const pending: Pending = { users: new Map(), lock: false }
	// The marker file exists (or may: a removal that failed).
	let stored = false

	function directory(userId: string, part: WipePart): string {
		return path.join(part === "sync" ? deps.syncRoot : deps.mountsRoot, userId)
	}

	// Writes what is pending, or removes the marker once nothing is.
	async function save(): Promise<void> {
		try {
			if (pending.users.size === 0 && !pending.lock) {
				if (stored) {
					await deps.marker.remove()
					stored = false
				}

				return
			}

			const users = Object.fromEntries([...pending.users].map(([userId, parts]) => [userId, [...parts]]))

			stored = true
			await deps.marker.write(Buffer.from(JSON.stringify({ version: 1, users, lock: pending.lock })))
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

	async function resetLock(when: string, reset: () => Promise<void>): Promise<boolean> {
		try {
			await reset()
		} catch (error) {
			log.warn(`sign-out: ${LABELS.lock} not removed ${when}: ${errorCode(error)}`)

			return false
		}

		pending.lock = false

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

		pending.lock = true
		// Listed before anything is deleted, so a sign-out cut short finishes on the next start.
		await save()

		if (user !== null) {
			for (const part of parts) {
				if (await removePart(user, part, "on sign-out, tried again next start")) {
					log.info(`sign-out: ${LABELS[part]} deleted`)
				}
			}

			if (!mountsCleared) {
				log.info(`sign-out: ${LABELS.mounts} kept for the uploads its cache may hold`)
			}
		}

		if (await resetLock("on sign-out, tried again next start", steps.resetLock)) {
			log.info(`sign-out: ${LABELS.lock} removed`)
		}

		await save()
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

		const read = parsePending(data)

		if (read === null) {
			log.warn("sign-out: wipe marker is invalid; dropped")
			await save()

			return
		}

		for (const [userId, parts] of read.users) {
			pending.users.set(userId, parts)
		}

		pending.lock = read.lock

		for (const [userId, parts] of [...pending.users]) {
			for (const part of [...parts]) {
				if (await removePart(userId, part, "after a sign-out, tried again next start")) {
					log.info(`sign-out: ${LABELS[part]} left by a sign-out deleted`)
				}
			}
		}

		if (pending.lock && (await resetLock("after a sign-out, tried again next start", () => deps.remove(deps.lockFile)))) {
			log.info(`sign-out: ${LABELS.lock} left by a sign-out removed`)
		}

		await save()
	}

	async function signedIn(userId: string): Promise<void> {
		const parts = pending.users.get(userId)

		if (parts === undefined && !pending.lock) {
			return
		}

		if (parts !== undefined) {
			steps.forget(userId, [...parts])

			for (const part of [...parts]) {
				await removePart(userId, part, "before a sign-in, kept")
			}

			pending.users.delete(userId)
		}

		if (pending.lock) {
			await resetLock("before a sign-in, kept", steps.resetLock)
			pending.lock = false
		}

		await save()
	}

	return {
		resume: () =>
			serial(resume).catch((error: unknown) => {
				log.warn(`sign-out: leftovers not deleted: ${errorCode(error)}`)
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
