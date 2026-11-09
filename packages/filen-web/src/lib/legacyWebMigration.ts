import type { StringifiedClient } from "@filen/sdk-rs"
import { convertLegacySession, LEGACY_SESSION_KEYS } from "@filen/shared/legacySession"
import { isNetworkClassErrorKind, runTimeout, TimeoutError } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { hasPersistedSession, persistSession } from "@/lib/sdk/session"
import { desktopBridge } from "@/lib/desktop"
import { kvHas, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY, fetchAccount } from "@/queries/account"
import { DEFAULT_NOTE_TYPE_KV_KEY } from "@/features/notes/lib/preferences"
import {
	DEFAULT_SORT_PREFERENCES,
	DEFAULT_VIEW_MODE_PREFERENCES,
	SORT_PREFERENCES_KV_KEY,
	VIEW_MODE_PREFERENCES_KV_KEY
} from "@/features/drive/lib/preferences"
import { DISMISSED_ANNOUNCEMENTS_KV_KEY } from "@/features/settings/lib/remoteConfig"
import {
	expectLegacyVerification,
	LEGACY_IDB_CACHE,
	LEGACY_IDB_SESSION,
	LEGACY_LOCAL_KEY_PREFIXES,
	LEGACY_LOCAL_KEYS,
	LEGACY_MAX_ATTEMPTS,
	LEGACY_PREF_KEYS,
	legacyWebWork,
	mapLegacyDismissedAnnouncements,
	mapLegacyNoteType,
	mapLegacySortPreferences,
	mapLegacyViewModePreferences,
	readLegacyMarker,
	updateLegacyMarker
} from "@/lib/legacyWebMigration.logic"

// Moves the previous web app's signed-in session and a few settings into this app on the first boot after the
// switch (both ran on this origin). The old session copies stay LEGACY_KEEP_MS after an import, so going back
// still works, then every trace of the previous app is removed by name.

const LOCK_NAME = "filen.legacyWebMigration"

// The import's one request. A slower answer leaves the session unverified, as offline does.
const VERIFY_TIMEOUT_MS = 15_000

// An IndexedDB delete waits while a previous-app tab holds the database open; it is retried on a later boot.
const IDB_DELETE_TIMEOUT_MS = 5_000

function readLocal(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function deleteDatabase(name: string): Promise<boolean> {
	if (typeof indexedDB === "undefined") {
		return Promise.resolve(true)
	}

	return new Promise(resolve => {
		const timer = setTimeout(() => {
			resolve(false)
		}, IDB_DELETE_TIMEOUT_MS)
		const settle = (deleted: boolean): void => {
			clearTimeout(timer)
			resolve(deleted)
		}

		try {
			const request = indexedDB.deleteDatabase(name)

			request.onsuccess = () => {
				settle(true)
			}
			request.onerror = () => {
				settle(false)
			}
			request.onblocked = () => {
				settle(false)
			}
		} catch {
			settle(false)
		}
	})
}

function removeLegacyLocalKeys(): void {
	try {
		for (const key of LEGACY_LOCAL_KEYS) {
			localStorage.removeItem(key)
		}

		for (let index = localStorage.length - 1; index >= 0; index--) {
			const key = localStorage.key(index)

			if (key !== null && LEGACY_LOCAL_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
				localStorage.removeItem(key)
			}
		}
	} catch {
		// Storage blocked: nothing could read the keys either; the marker keeps the wipe due.
	}

	// The previous app's theme, normally already moved and expired before paint (public/theme.js).
	if (typeof document !== "undefined") {
		document.cookie = "theme=; Max-Age=0; path=/"
	}
}

// Removes everything the previous app left: its localStorage keys, the theme cookie and both IndexedDBs. The marker
// turns done once the databases are gone too; until then it stays retired and a later boot retries. Never rejects.
export async function wipeLegacyWebData(): Promise<void> {
	updateLegacyMarker(marker => ({ ...marker, stage: "retired" }))
	removeLegacyLocalKeys()

	const [session, cache] = await Promise.all([deleteDatabase(LEGACY_IDB_SESSION), deleteDatabase(LEGACY_IDB_CACHE)])

	if (session && cache) {
		updateLegacyMarker(() => ({ stage: "done" }))
	} else {
		log.warn("legacyWeb", "the previous app's databases are still open elsewhere; retrying on a later start")
	}
}

// A sign-out's part: nothing of the previous app may sign the account back in afterwards. Skipped on desktop, which
// never held the previous web app's data. Never rejects; blocked databases are retried by a later boot.
export function wipeLegacyWebOnSignOut(): Promise<void> {
	if (desktopBridge() !== undefined) {
		return Promise.resolve()
	}

	const marker = readLegacyMarker()

	if (marker?.stage === "done") {
		return Promise.resolve()
	}

	return wipeLegacyWebData()
}

// Nothing to keep: the old data goes now.
function retire(): void {
	void wipeLegacyWebData()
}

async function writeIfAbsent(key: string, value: unknown): Promise<void> {
	if (!(await kvHas(key))) {
		await kvSetJson(key, value)
	}
}

// Settings verbatim, each only where this app holds none yet. Independent of the session: the previous app kept them
// across its own sign-outs.
async function importLegacyPrefs(rootUuid: string | null): Promise<void> {
	const noteType = mapLegacyNoteType(readLocal(LEGACY_PREF_KEYS.noteType))
	const sort = mapLegacySortPreferences(readLocal(LEGACY_PREF_KEYS.sortBy), rootUuid, DEFAULT_SORT_PREFERENCES)
	const view = mapLegacyViewModePreferences(readLocal(LEGACY_PREF_KEYS.listType), rootUuid, DEFAULT_VIEW_MODE_PREFERENCES)
	const dismissed = mapLegacyDismissedAnnouncements(readLocal(LEGACY_PREF_KEYS.dismissedAnnouncements))
	const writes: [string, unknown][] = [
		[DEFAULT_NOTE_TYPE_KV_KEY, noteType],
		[SORT_PREFERENCES_KV_KEY, sort],
		[VIEW_MODE_PREFERENCES_KV_KEY, view],
		[DISMISSED_ANNOUNCEMENTS_KV_KEY, dismissed]
	]

	await Promise.all(writes.filter(([, value]) => value !== null).map(([key, value]) => writeIfAbsent(key, value)))
}

type Verification = "verified" | "unverified" | "dead" | "failed"

// One account read, which also seeds the account query so the shell does not repeat it. Offline, or no answer in
// time, leaves the session unverified: the first account read that succeeds later verifies it.
async function verifyImport(): Promise<Verification> {
	if (typeof navigator !== "undefined" && !navigator.onLine) {
		return "unverified"
	}

	const read = await runTimeout(() => fetchAccount(), VERIFY_TIMEOUT_MS)

	if (read.success) {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, read.data)

		return "verified"
	}

	if (read.error instanceof TimeoutError) {
		return "unverified"
	}

	const kind = asErrorDTO(read.error).kind

	if (kind === "Unauthenticated") {
		return "dead"
	}

	return isNetworkClassErrorKind(kind) ? "unverified" : "failed"
}

async function dropInjectedClient(): Promise<void> {
	try {
		await sdkApi.logout()
	} catch (e) {
		log.warn("legacyWeb", "dropping the imported client failed", asErrorDTO(e).label)
	}
}

// Under the lock. True when it injected a session this boot then needs not inject again.
async function migrateLocked(now: number): Promise<boolean> {
	const marker = readLegacyMarker()

	// Another tab finished while this one waited for the lock.
	if (marker !== null && marker.stage !== "pending") {
		return false
	}

	const converted = convertLegacySession(readLocal(LEGACY_SESSION_KEYS.authed), readLocal(LEGACY_SESSION_KEYS.sdkConfig))

	if (marker?.prefs !== true) {
		try {
			await importLegacyPrefs(converted.ok ? converted.session.rootUuid : null)
			updateLegacyMarker(current => ({ ...(current ?? { stage: "pending" }), prefs: true }))
		} catch (e) {
			log.warn("legacyWeb", "importing the previous app's settings failed", asErrorDTO(e).label)
		}
	}

	if (marker?.cacheWiped !== true) {
		void deleteDatabase(LEGACY_IDB_CACHE).then(deleted => {
			if (deleted) {
				updateLegacyMarker(current => ({ ...(current ?? { stage: "pending" }), cacheWiped: true }))
			}
		})
	}

	if (!converted.ok) {
		log.info("legacyWeb", `no session to import (${converted.reason})`)
		retire()

		return false
	}

	if (await hasPersistedSession()) {
		// A session here after an attempt of this import: the page died between saving it and the marker.
		if (marker !== null && (marker.attempts ?? 0) > 0) {
			updateLegacyMarker(current => ({ ...(current ?? marker), stage: "imported", at: now, verified: false }))
			expectLegacyVerification()
		} else {
			// This app's own session wins; the old one is not kept for it.
			retire()
		}

		return false
	}

	const attempts = (marker?.attempts ?? 0) + 1

	if (attempts > LEGACY_MAX_ATTEMPTS) {
		log.warn("legacyWeb", "giving up the session import after repeated failures")
		retire()

		return false
	}

	updateLegacyMarker(current => ({ ...(current ?? { stage: "pending" }), stage: "pending", attempts, at: marker?.at ?? now }))

	const session: StringifiedClient = converted.session

	try {
		await sdkApi.injectClient(session)
	} catch (e) {
		log.warn("legacyWeb", "the SDK rejected the previous app's session", asErrorDTO(e).label)
		retire()

		return false
	}

	const verification = await verifyImport()

	if (verification === "dead") {
		log.info("legacyWeb", "the previous app's session has ended; nothing to import")
		await dropInjectedClient()
		retire()

		return false
	}

	if (verification === "failed") {
		// Tried again on the next start, up to LEGACY_MAX_ATTEMPTS.
		await dropInjectedClient()

		return false
	}

	try {
		await persistSession(session)
	} catch (e) {
		// Signed in for this tab only; the next start imports again.
		log.warn("legacyWeb", "saving the imported session failed", asErrorDTO(e).label)

		return true
	}

	updateLegacyMarker(current => ({
		...(current ?? { stage: "pending" }),
		stage: "imported",
		at: now,
		verified: verification === "verified"
	}))

	if (verification === "unverified") {
		expectLegacyVerification()
	}

	log.info("legacyWeb", `imported the previous app's session (${verification})`)

	return true
}

function withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
	// A second tab waits, then finds the first one's result (marker and session) and does nothing.
	if (typeof navigator === "undefined" || !("locks" in navigator)) {
		return fn()
	}

	return navigator.locks.request(LOCK_NAME, fn)
}

/**
 * The boot's step, after the client config and before the session resume. Resolves true when it injected the
 * imported session, so the resume need not inject it again. A browser without the previous app's data pays two
 * synchronous localStorage reads. Never rejects: any failure leaves the boot signed out, as it would be without it.
 */
export async function runLegacyWebMigration(now: number = Date.now()): Promise<boolean> {
	if (desktopBridge() !== undefined) {
		return false
	}

	const work = legacyWebWork(now)

	if (work === "none") {
		return false
	}

	if (work === "wipe") {
		void wipeLegacyWebData()

		return false
	}

	try {
		return await withMigrationLock(() => migrateLocked(now))
	} catch (e) {
		log.error("legacyWeb", "the previous app's import failed", asErrorDTO(e).label)

		return false
	}
}
