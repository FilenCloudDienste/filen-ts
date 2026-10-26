import { type } from "arktype"
import { desktopPinSchema } from "@filen/shared/desktopLock"
import { sessionEnvelopeSchema } from "@filen/shared/session"
import { SESSION_BLOB_MAX_LENGTH } from "../shared/channels.ts"

// What the old client (3.0.53) kept in its renderer's localStorage on filendesktop://bundle. Its web app wrote every
// value with JSON.stringify (usehooks' useLocalStorage), so each raw string is JSON, `authed` included ("true").
export const LEGACY_KEYS = {
	authed: "authed:4:4:4",
	sdkConfig: "sdkConfig:4:4",
	desktopConfig: "desktopConfig:4:4",
	sync: "syncConfig:1",
	networkDrive: "networkDriveConfig:1",
	webdav: "webdavConfig:1",
	s3: "s3Config:1",
	lockPin: "lockPin",
	lockTimeout: "lockTimeout",
	minimizeToTray: "minimizeToTrayEnabled",
	startMinimized: "startMinimizedEnabled"
} as const

type LegacyKey = (typeof LEGACY_KEYS)[keyof typeof LEGACY_KEYS]

// Raw localStorage strings by key; an absent key is missing.
export type LegacySnapshot = Partial<Record<LegacyKey, string>>

// Run in the old origin's page by executeJavaScript; returns the listed keys and how many keys the origin holds.
export const READ_SCRIPT = `(() => {
	const values = {}
	for (const key of ${JSON.stringify(Object.values(LEGACY_KEYS))}) {
		const value = localStorage.getItem(key)
		if (value !== null) values[key] = value
	}
	return { count: localStorage.length, values }
})()`

// Removes the old origin's plaintext secrets and nothing else: the account (sdkConfig, and its copy inside
// desktopConfig), the PIN, the WebDAV and S3 passwords, and the old web app's IndexedDB, which held further copies of
// sdkConfig and desktopConfig beside caches. The non-secret config stays for the later migration phases. Resolves
// true once the IndexedDB is gone.
export const WIPE_SCRIPT = `(async () => {
	const dropPassword = config => { if (config !== null && typeof config === "object") delete config.password }
	const dropSecretKey = config => { if (config !== null && typeof config === "object") delete config.secretKeyId }
	const edit = (key, change) => {
		const raw = localStorage.getItem(key)
		if (raw === null) return
		let value
		try { value = JSON.parse(raw) } catch { localStorage.removeItem(key); return }
		if (value === null || typeof value !== "object") return
		change(value)
		localStorage.setItem(key, JSON.stringify(value))
	}
	localStorage.removeItem(${JSON.stringify(LEGACY_KEYS.sdkConfig)})
	localStorage.removeItem(${JSON.stringify(LEGACY_KEYS.lockPin)})
	edit(${JSON.stringify(LEGACY_KEYS.desktopConfig)}, config => {
		delete config.sdkConfig
		dropPassword(config.webdavConfig)
		dropSecretKey(config.s3Config)
	})
	edit(${JSON.stringify(LEGACY_KEYS.webdav)}, users => { for (const id of Object.keys(users)) dropPassword(users[id]) })
	edit(${JSON.stringify(LEGACY_KEYS.s3)}, users => { for (const id of Object.keys(users)) dropSecretKey(users[id]) })
	return await new Promise(resolve => {
		const request = indexedDB.deleteDatabase("Filen")
		request.onsuccess = () => resolve(true)
		request.onerror = () => resolve(false)
		request.onblocked = () => resolve(false)
	})
})()`

// localStorage caps an origin at a few MB; this only stops an unbounded payload.
const readResultSchema = type({
	count: "0 <= number.integer < 1000000",
	values: type({ "[string]": "string <= 16777216" })
})

// The listed keys out of what READ_SCRIPT returned; null when it is not that shape.
export function parseReadResult(value: unknown): { count: number; snapshot: LegacySnapshot } | null {
	const result = readResultSchema(value)

	if (result instanceof type.errors) {
		return null
	}

	const snapshot: LegacySnapshot = {}

	for (const key of Object.values(LEGACY_KEYS)) {
		const raw = result.values[key]

		if (raw !== undefined) {
			snapshot[key] = raw
		}
	}

	return { count: result.count, snapshot }
}

function parseJson(raw: string | undefined): unknown {
	if (raw === undefined) {
		return undefined
	}

	try {
		return JSON.parse(raw) as unknown
	} catch {
		return undefined
	}
}

// A safe integer: the old userId is a JS number.
const USER_ID = "1 < number.integer <= 9007199254740991"

// The old JS SDK's FilenSDKConfig, only the fields the session needs. `password` and `twoFactorCode` were stored as
// "redacted" and are never read. The old client's own test for a real key: longer than 32 and not "anonymous".
const sdkConfigSchema = type({
	email: "string > 0",
	masterKeys: type("string > 0").array().atLeastLength(1),
	apiKey: "string > 32",
	privateKey: "string > 0",
	authVersion: "1 | 2 | 3",
	baseFolderUUID: "string > 0",
	// The old client treats 1 (and anything not positive) as signed out.
	userId: USER_ID
})

export type LegacySessionFailure = "not-signed-in" | "invalid-account"

export type LegacySession = { ok: true; blob: string; userId: number } | { ok: false; reason: LegacySessionFailure }

// The old account as the web's session envelope (the shape `persistSession` stores), converted like sdk-rs's
// `From<FilenSDKConfig> for StringifiedClient`: rootUuid is baseFolderUUID, authInfo the master keys joined by "|",
// the public key dropped (derived from the private key). Only `userId` is a bigint, which the envelope writes as
// "$bigint:<digits>n". A value starting with "$" would need the envelope's escape; no real one does, so such an
// account is refused instead. Failures name a reason, never a value.
export function legacySession(snapshot: LegacySnapshot): LegacySession {
	if (snapshot[LEGACY_KEYS.authed] !== "true") {
		return { ok: false, reason: "not-signed-in" }
	}

	const config = sdkConfigSchema(parseJson(snapshot[LEGACY_KEYS.sdkConfig]))

	if (config instanceof type.errors || config.apiKey === "anonymous" || config.masterKeys.some(key => key.includes("|"))) {
		return { ok: false, reason: "invalid-account" }
	}

	const strings = {
		email: config.email,
		rootUuid: config.baseFolderUUID,
		authInfo: config.masterKeys.join("|"),
		privateKey: config.privateKey,
		apiKey: config.apiKey
	}

	if (Object.values(strings).some(value => value.startsWith("$"))) {
		return { ok: false, reason: "invalid-account" }
	}

	const envelope = { ...strings, userId: `$bigint:${String(config.userId)}n`, authVersion: config.authVersion }
	const blob = JSON.stringify(envelope)

	if (blob.length > SESSION_BLOB_MAX_LENGTH || sessionEnvelopeSchema(envelope) instanceof type.errors) {
		return { ok: false, reason: "invalid-account" }
	}

	return { ok: true, blob, userId: config.userId }
}

// The old lock was active only with both a PIN and an inactivity timeout; a PIN alone never locked anything, so it
// is not carried over. A PIN the new lock cannot take (it allows 4-12 digits) is dropped too.
export function legacyPin(snapshot: LegacySnapshot): string | null {
	const pin = parseJson(snapshot[LEGACY_KEYS.lockPin])
	const timeout = parseJson(snapshot[LEGACY_KEYS.lockTimeout])

	if (typeof timeout !== "number" || !(timeout > 0) || desktopPinSchema(pin) instanceof type.errors) {
		return null
	}

	return pin as string
}

// options.v1.json, the old main process's mirror of the two settings; unknown fields are dropped.
const legacyOptionsSchema = type({ "minimizeToTray?": "boolean", "startMinimized?": "boolean", "+": "delete" })

export interface LegacyPrefs {
	minimizeToTray?: boolean
	startMinimized?: boolean
}

// The old main read these from options.v1.json; the old web's localStorage booleans are the fallback when the file
// lacks one (it wrote minimizeToTray only once it was first toggled).
export function legacyPrefs(snapshot: LegacySnapshot, optionsFile: string | null): LegacyPrefs {
	const parsed = legacyOptionsSchema(optionsFile === null ? undefined : parseJson(optionsFile))
	const options = parsed instanceof type.errors ? {} : parsed
	const stored = (key: LegacyKey): boolean | undefined => {
		const value = parseJson(snapshot[key])

		return typeof value === "boolean" ? value : undefined
	}
	const prefs: LegacyPrefs = {}
	const minimizeToTray = options.minimizeToTray ?? stored(LEGACY_KEYS.minimizeToTray)
	const startMinimized = options.startMinimized ?? stored(LEGACY_KEYS.startMinimized)

	if (minimizeToTray !== undefined) {
		prefs.minimizeToTray = minimizeToTray
	}

	if (startMinimized !== undefined) {
		prefs.startMinimized = startMinimized
	}

	return prefs
}

export const LEGACY_FEATURES = ["sync", "networkDrive", "webdav", "s3"] as const

export type LegacyFeature = (typeof LEGACY_FEATURES)[number]

// desktopConfig's name for each feature's section.
const SECTION: Record<LegacyFeature, string> = {
	sync: "syncConfig",
	networkDrive: "networkDriveConfig",
	webdav: "webdavConfig",
	s3: "s3Config"
}

// The config of the sync pairs, network drive, WebDAV and S3 for the later phases, kept encrypted. Shapes are the old
// client's and stay unknown JSON here; each phase validates its own part when it applies it. `users` are the per-user
// maps (userId digits to config), other accounts' included; `fallback` is desktopConfig's section, which the old
// client used when the map had no entry for the signed-in user.
export interface LegacyStash {
	version: 1
	userId: number | null
	users: Record<LegacyFeature, Record<string, unknown>>
	fallback: Partial<Record<LegacyFeature, unknown>>
}

// A JSON object (arrays are objects to arktype too).
const recordSchema = type({ "[string]": "unknown" }).narrow(value => !Array.isArray(value))

// A per-user map: only its userId keys.
function usersOf(value: unknown): Record<string, unknown> {
	const record = recordSchema(value)

	return record instanceof type.errors ? {} : Object.fromEntries(Object.entries(record).filter(([id]) => /^\d+$/.test(id)))
}

const usersSchema = recordSchema.pipe(usersOf)

const stashSchema = type({
	version: "1",
	userId: type(USER_ID).or("null"),
	users: type({ sync: usersSchema, networkDrive: usersSchema, webdav: usersSchema, s3: usersSchema }),
	fallback: type({ "sync?": "unknown", "networkDrive?": "unknown", "webdav?": "unknown", "s3?": "unknown" })
})

// null when the old client had none of it. `userId` is the old signed-in account, whose fallback sections these are.
// desktopConfig's sdkConfig copy is never taken.
export function legacyStash(snapshot: LegacySnapshot, userId: number | null): LegacyStash | null {
	const desktopConfig = recordSchema(parseJson(snapshot[LEGACY_KEYS.desktopConfig]))
	const sections = desktopConfig instanceof type.errors ? {} : desktopConfig
	const stash: LegacyStash = { version: 1, userId, users: { sync: {}, networkDrive: {}, webdav: {}, s3: {} }, fallback: {} }
	let empty = true

	for (const feature of LEGACY_FEATURES) {
		const users = usersOf(parseJson(snapshot[LEGACY_KEYS[feature]]))

		if (Object.keys(users).length > 0) {
			stash.users[feature] = users
			empty = false
		}

		const section = sections[SECTION[feature]]

		if (section !== undefined && section !== null) {
			stash.fallback[feature] = section
			empty = false
		}
	}

	return empty ? null : stash
}

export function parseStash(text: string): LegacyStash | null {
	const stash = stashSchema(parseJson(text))

	return stash instanceof type.errors ? null : stash
}

// The old client's rule, `map[userId] ?? desktopConfig.<section>`, except that the fallback belongs to the account
// that was signed in: another account never gets it (it holds that account's pairs and mounts).
export function effectiveConfig(stash: LegacyStash, userId: number | bigint | string, feature: LegacyFeature): unknown {
	const id = String(userId)

	return stash.users[feature][id] ?? (stash.userId !== null && String(stash.userId) === id ? stash.fallback[feature] : undefined)
}
