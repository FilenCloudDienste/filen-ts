import { describe, expect, it } from "vitest"
import { type } from "arktype"
import { sessionEnvelopeSchema } from "@filen/shared/session"
import {
	effectiveConfig,
	LEGACY_KEYS,
	legacyPin,
	legacyPrefs,
	legacySession,
	type LegacySnapshot,
	legacyStash,
	parseReadResult,
	parseStash,
	READ_SCRIPT,
	sessionUserId,
	WIPE_SCRIPT
} from "../main/legacyData.ts"
import { isSessionBlob } from "../main/sessionVault.ts"

// Fixtures only: shaped like the old client's values, with made-up content.
const SDK_CONFIG = {
	email: "user@example.com",
	password: "redacted",
	twoFactorCode: "redacted",
	masterKeys: ["first-master-key", "second-master-key"],
	apiKey: "a".repeat(64),
	publicKey: "public-key",
	privateKey: "private-key",
	authVersion: 2,
	baseFolderUUID: "00000000-0000-4000-8000-000000000001",
	userId: 123456,
	metadataCache: true,
	tmpPath: "",
	connectToSocket: true
}

function snapshot(overrides: Partial<Record<string, unknown>> = {}): LegacySnapshot {
	const values: Record<string, unknown> = { [LEGACY_KEYS.authed]: true, [LEGACY_KEYS.sdkConfig]: SDK_CONFIG, ...overrides }

	return Object.fromEntries(
		Object.entries(values)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, JSON.stringify(value)])
	) as LegacySnapshot
}

function fakeStorage(entries: Record<string, string>) {
	const map = new Map(Object.entries(entries))

	return {
		map,
		get length() {
			return map.size
		},
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value)
		},
		removeItem: (key: string) => {
			map.delete(key)
		}
	}
}

function fakeIndexedDb(outcome: "success" | "error" | "blocked") {
	const deleted: string[] = []

	return {
		deleted,
		deleteDatabase: (name: string) => {
			const request: Record<string, (() => void) | undefined> = {}

			deleted.push(name)
			queueMicrotask(() => {
				request[`on${outcome}`]?.()
			})

			return request
		}
	}
}

function runScript(script: string, storage: unknown, indexedDB: unknown = undefined): unknown {
	return new Function("localStorage", "indexedDB", `return ${script}`)(storage, indexedDB) as unknown
}

describe("READ_SCRIPT", () => {
	it("returns the listed keys and the origin's key count", () => {
		const storage = fakeStorage({ [LEGACY_KEYS.authed]: "true", [LEGACY_KEYS.lockPin]: '"1234"', theme: '"dark"' })

		expect(runScript(READ_SCRIPT, storage)).toEqual({
			count: 3,
			values: { [LEGACY_KEYS.authed]: "true", [LEGACY_KEYS.lockPin]: '"1234"' }
		})
	})
})

describe("parseReadResult", () => {
	it("keeps only the listed keys", () => {
		expect(parseReadResult({ count: 2, values: { [LEGACY_KEYS.authed]: "true", other: "x" } })).toEqual({
			count: 2,
			snapshot: { [LEGACY_KEYS.authed]: "true" }
		})
	})

	it("rejects anything else", () => {
		expect(parseReadResult(null)).toBeNull()
		expect(parseReadResult({ count: -1, values: {} })).toBeNull()
		expect(parseReadResult({ count: 1, values: { [LEGACY_KEYS.authed]: 1 } })).toBeNull()
	})
})

describe("WIPE_SCRIPT", () => {
	it("removes the secrets, keeps the rest and deletes the old IndexedDB", async () => {
		const storage = fakeStorage({
			[LEGACY_KEYS.authed]: "true",
			[LEGACY_KEYS.sdkConfig]: JSON.stringify(SDK_CONFIG),
			[LEGACY_KEYS.lockPin]: '"1234"',
			[LEGACY_KEYS.lockTimeout]: "300",
			[LEGACY_KEYS.desktopConfig]: JSON.stringify({
				sdkConfig: SDK_CONFIG,
				syncConfig: { enabled: true, syncPairs: [] },
				webdavConfig: { enabled: true, username: "u", password: "p", port: 1900 },
				s3Config: { enabled: false, accessKeyId: "k", secretKeyId: "s", port: 1800 }
			}),
			[LEGACY_KEYS.webdav]: JSON.stringify({ "123456": { username: "u", password: "p" }, "7": { password: "q" } }),
			[LEGACY_KEYS.s3]: JSON.stringify({ "123456": { accessKeyId: "k", secretKeyId: "s" } }),
			[LEGACY_KEYS.sync]: JSON.stringify({ "123456": { syncPairs: [] } }),
			theme: '"dark"'
		})
		const indexedDB = fakeIndexedDb("success")

		await expect(runScript(WIPE_SCRIPT, storage, indexedDB)).resolves.toBe(true)
		expect(indexedDB.deleted).toEqual(["Filen"])
		expect(storage.map.has(LEGACY_KEYS.sdkConfig)).toBe(false)
		expect(storage.map.has(LEGACY_KEYS.lockPin)).toBe(false)
		expect(JSON.parse(storage.map.get(LEGACY_KEYS.desktopConfig) ?? "")).toEqual({
			syncConfig: { enabled: true, syncPairs: [] },
			webdavConfig: { enabled: true, username: "u", port: 1900 },
			s3Config: { enabled: false, accessKeyId: "k", port: 1800 }
		})
		expect(JSON.parse(storage.map.get(LEGACY_KEYS.webdav) ?? "")).toEqual({ "123456": { username: "u" }, "7": {} })
		expect(JSON.parse(storage.map.get(LEGACY_KEYS.s3) ?? "")).toEqual({ "123456": { accessKeyId: "k" } })
		expect(storage.map.get(LEGACY_KEYS.sync)).toBe(JSON.stringify({ "123456": { syncPairs: [] } }))
		expect(storage.map.get(LEGACY_KEYS.authed)).toBe("true")
		expect(storage.map.get(LEGACY_KEYS.lockTimeout)).toBe("300")
		expect(storage.map.get("theme")).toBe('"dark"')
	})

	it("removes a value it cannot parse and reports an IndexedDB that was not deleted", async () => {
		const storage = fakeStorage({ [LEGACY_KEYS.webdav]: "{" })

		await expect(runScript(WIPE_SCRIPT, storage, fakeIndexedDb("error"))).resolves.toBe(false)
		expect(storage.map.has(LEGACY_KEYS.webdav)).toBe(false)
		await expect(runScript(WIPE_SCRIPT, fakeStorage({}), fakeIndexedDb("blocked"))).resolves.toBe(false)
	})
})

describe("legacySession", () => {
	it("converts the old account into the web's session envelope", () => {
		const session = legacySession(snapshot())

		expect(session).toMatchObject({ ok: true, userId: 123456 })

		if (!session.ok) {
			return
		}

		expect(JSON.parse(session.blob)).toEqual({
			email: "user@example.com",
			rootUuid: "00000000-0000-4000-8000-000000000001",
			authInfo: "first-master-key|second-master-key",
			privateKey: "private-key",
			apiKey: "a".repeat(64),
			userId: "$bigint:123456n",
			authVersion: 2
		})
		expect(isSessionBlob(session.blob)).toBe(true)
		expect(sessionEnvelopeSchema(JSON.parse(session.blob)) instanceof type.errors).toBe(false)
	})

	it("needs the old client's signed-in flag", () => {
		expect(legacySession(snapshot({ [LEGACY_KEYS.authed]: false }))).toEqual({ ok: false, reason: "not-signed-in" })
		expect(legacySession(snapshot({ [LEGACY_KEYS.authed]: undefined }))).toEqual({ ok: false, reason: "not-signed-in" })
	})

	it.each([
		["the anonymous config", { apiKey: "anonymous" }],
		["a short api key", { apiKey: "short" }],
		["the signed-out user id", { userId: 1 }],
		["a fractional user id", { userId: 2.5 }],
		["an unsafe user id", { userId: 2 ** 60 }],
		["an unknown auth version", { authVersion: 4 }],
		["no master keys", { masterKeys: [] }],
		["a master key with the separator", { masterKeys: ["a|b"] }],
		["a value the envelope would have to escape", { email: "$bigint:1n" }],
		["a missing field", { privateKey: undefined }]
	])("refuses %s", (_label, change) => {
		expect(legacySession(snapshot({ [LEGACY_KEYS.sdkConfig]: { ...SDK_CONFIG, ...change } }))).toEqual({
			ok: false,
			reason: "invalid-account"
		})
	})

	it("refuses an unparsable config", () => {
		expect(legacySession({ [LEGACY_KEYS.authed]: "true", [LEGACY_KEYS.sdkConfig]: "{" })).toEqual({
			ok: false,
			reason: "invalid-account"
		})
	})
})

describe("sessionUserId", () => {
	it("reads the envelope's user id", () => {
		expect(sessionUserId(JSON.stringify({ userId: "$bigint:42n" }))).toBe("42")
		expect(sessionUserId(JSON.stringify({ userId: 42 }))).toBeNull()
		expect(sessionUserId("{")).toBeNull()
	})
})

describe("legacyPin", () => {
	it("takes the PIN only when the old lock was active", () => {
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "1234", [LEGACY_KEYS.lockTimeout]: 300 }))).toBe("1234")
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "1234", [LEGACY_KEYS.lockTimeout]: 0 }))).toBeNull()
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "1234" }))).toBeNull()
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "", [LEGACY_KEYS.lockTimeout]: 300 }))).toBeNull()
	})

	it("drops a PIN the new lock cannot take", () => {
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "12a4", [LEGACY_KEYS.lockTimeout]: 300 }))).toBeNull()
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: "1".repeat(13), [LEGACY_KEYS.lockTimeout]: 300 }))).toBeNull()
		expect(legacyPin(snapshot({ [LEGACY_KEYS.lockPin]: 1234, [LEGACY_KEYS.lockTimeout]: 300 }))).toBeNull()
	})
})

describe("legacyPrefs", () => {
	it("prefers options.v1.json and falls back to the old web's booleans", () => {
		const stored = snapshot({ [LEGACY_KEYS.minimizeToTray]: true, [LEGACY_KEYS.startMinimized]: true })

		expect(legacyPrefs(stored, JSON.stringify({ startMinimized: false, extra: 1 }))).toEqual({
			minimizeToTray: true,
			startMinimized: false
		})
		expect(legacyPrefs(stored, null)).toEqual({ minimizeToTray: true, startMinimized: true })
		expect(legacyPrefs(snapshot(), "{")).toEqual({})
		expect(legacyPrefs(snapshot(), JSON.stringify({ minimizeToTray: "yes" }))).toEqual({})
	})
})

describe("legacyStash", () => {
	const desktopConfig = {
		sdkConfig: SDK_CONFIG,
		syncConfig: { enabled: true, syncPairs: [{ uuid: "fallback-pair" }] },
		networkDriveConfig: { enabled: false },
		webdavConfig: { enabled: false, password: "admin" },
		s3Config: { enabled: false }
	}
	const stored = snapshot({
		[LEGACY_KEYS.desktopConfig]: desktopConfig,
		[LEGACY_KEYS.sync]: { "123456": { syncPairs: [{ uuid: "own-pair" }] }, "777": { syncPairs: [{ uuid: "other-pair" }] }, x: 1 },
		[LEGACY_KEYS.webdav]: [1, 2]
	})

	it("keeps every user's maps and desktopConfig's sections, never the sdkConfig copy", () => {
		const stash = legacyStash(stored, 123456)

		expect(stash).toEqual({
			version: 1,
			userId: 123456,
			users: {
				sync: { "123456": { syncPairs: [{ uuid: "own-pair" }] }, "777": { syncPairs: [{ uuid: "other-pair" }] } },
				networkDrive: {},
				webdav: {},
				s3: {}
			},
			fallback: {
				sync: desktopConfig.syncConfig,
				networkDrive: desktopConfig.networkDriveConfig,
				webdav: desktopConfig.webdavConfig,
				s3: desktopConfig.s3Config
			}
		})
		expect(JSON.stringify(stash)).not.toContain("first-master-key")
	})

	it("is null without any config", () => {
		expect(legacyStash(snapshot(), 123456)).toBeNull()
	})

	it("round-trips through parseStash and rejects other text", () => {
		const stash = legacyStash(stored, null)

		expect(parseStash(JSON.stringify(stash))).toEqual(stash)
		expect(parseStash("{")).toBeNull()
		expect(parseStash(JSON.stringify({ ...stash, version: 2 }))).toBeNull()
	})
})

describe("effectiveConfig", () => {
	const stash = legacyStash(
		snapshot({
			[LEGACY_KEYS.desktopConfig]: { syncConfig: { syncPairs: ["fallback"] }, s3Config: { enabled: true } },
			[LEGACY_KEYS.sync]: { "123456": { syncPairs: ["own"] }, "777": { syncPairs: ["other"] } }
		}),
		123456
	)

	it("uses the user's map entry, then the old account's fallback", () => {
		expect(stash).not.toBeNull()

		if (stash === null) {
			return
		}

		expect(effectiveConfig(stash, 123456, "sync")).toEqual({ syncPairs: ["own"] })
		expect(effectiveConfig(stash, 123456n, "s3")).toEqual({ enabled: true })
		expect(effectiveConfig(stash, "777", "sync")).toEqual({ syncPairs: ["other"] })
	})

	it("never gives another account the old account's fallback", () => {
		if (stash === null) {
			return
		}

		expect(effectiveConfig(stash, 777, "s3")).toBeUndefined()
		expect(effectiveConfig({ ...stash, userId: null }, 123456, "s3")).toBeUndefined()
	})
})
