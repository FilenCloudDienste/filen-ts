import { type } from "arktype"
import type { LockEvent, LockId } from "@filen/sdk-rs"
import { isUuid, runTimeout } from "@filen/shared"
import { log } from "@/lib/log"

// The locks this page's client may still owe a release for, keyed by lock uuid: the SDK reports each owed from its
// first acquire and settled once its release was answered or given up on. A reload loses a release in flight, and the
// next write then waits out the server lease, so pagehide hands these to the next page, which releases them before its
// first write. Empty while nothing holds a lock, and then nothing touches storage.
const owed = new Map<string, LockId>()

// sessionStorage: per tab, survives a reload, gone with the tab. A duplicated tab copies it, so boot consumes it at once.
export const OWED_LOCKS_KEY = "filen.owedLocks"

// Boot waits this long at most. A release still unanswered then carries on in the background; a lease nobody releases
// lapses by its TTL as before.
export const OWED_LOCKS_RELEASE_TIMEOUT_MS = 3_000

const owedLocksSchema = type({ uuid: "string", resource: "string" }).array()

// The schema checks the shape; the SDK's uuid type also needs the uuid form.
function isLockId(lock: { uuid: string; resource: string }): lock is LockId {
	return isUuid(lock.uuid)
}

// The worker forwards every lock event of the live client here.
export function onLockEvent(event: LockEvent): void {
	if (event.kind === "owed") {
		owed.set(event.lock.uuid, event.lock)
	} else {
		owed.delete(event.lock.uuid)
	}
}

export function owedLocks(): ReadonlyMap<string, LockId> {
	return owed
}

// A bfcache entry (persisted) keeps its client alive, so it hands nothing on.
export function persistOwedLocks(event: { persisted: boolean }): void {
	if (event.persisted) {
		return
	}

	try {
		if (owed.size === 0) {
			sessionStorage.removeItem(OWED_LOCKS_KEY)
		} else {
			sessionStorage.setItem(OWED_LOCKS_KEY, JSON.stringify([...owed.values()]))
		}
	} catch {
		// Storage blocked: the leases lapse by their TTL instead.
	}
}

// A page restored from the bfcache still holds its own client and its locks.
export function forgetPersistedOwedLocks(event: { persisted: boolean }): void {
	if (!event.persisted) {
		return
	}

	try {
		sessionStorage.removeItem(OWED_LOCKS_KEY)
	} catch {
		// Storage blocked: nothing was written either.
	}
}

export function installOwedLocksHandoff(target: Pick<Window, "addEventListener"> = window): void {
	target.addEventListener("pagehide", persistOwedLocks)
	target.addEventListener("pageshow", forgetPersistedOwedLocks)
}

// Consumes what the page before this one handed on: removed at once, so a tab duplicated later copies nothing, and
// added to the mirror, so a reload during their release hands them on again. A lock this client reported itself is
// left out: releasing it would free it under the client.
export function takeInheritedOwedLocks(): LockId[] {
	let raw: string | null

	try {
		raw = sessionStorage.getItem(OWED_LOCKS_KEY)

		if (raw !== null) {
			sessionStorage.removeItem(OWED_LOCKS_KEY)
		}
	} catch {
		return []
	}

	if (raw === null) {
		return []
	}

	let parsed: unknown

	try {
		parsed = JSON.parse(raw)
	} catch {
		log.warn("locks", "dropping unparseable owed locks")

		return []
	}

	const result = owedLocksSchema(parsed)

	if (result instanceof type.errors) {
		log.warn("locks", "dropping invalid owed locks")

		return []
	}

	const inherited = result.filter(isLockId).filter(lock => !owed.has(lock.uuid))

	for (const lock of inherited) {
		owed.set(lock.uuid, lock)
	}

	return inherited
}

// Releases the inherited locks, bounded: on a timeout boot goes on and the release keeps running. The SDK reports each
// lock settled as its release is answered, which clears it from the mirror; a release that resolved clears its locks
// here too, so a listener that never attached cannot carry them from page to page.
export async function releaseInheritedOwedLocks(
	locks: LockId[],
	release: (locks: LockId[]) => Promise<void>,
	timeoutMs: number = OWED_LOCKS_RELEASE_TIMEOUT_MS
): Promise<void> {
	if (locks.length === 0) {
		return
	}

	const result = await runTimeout(() => release(locks), timeoutMs)

	if (!result.success) {
		log.warn("locks", "releasing the previous page's locks did not finish; continuing", result.error)

		return
	}

	for (const lock of locks) {
		owed.delete(lock.uuid)
	}
}
