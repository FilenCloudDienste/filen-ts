import { beforeEach, describe, expect, it, vi } from "vitest"

// The boot's import of the previous web app's session and settings, against mocked SDK, kv and browser storage.
const { sdkApi, kv, session, fetchAccount, setQueryData, bridge } = vi.hoisted(() => ({
	sdkApi: { injectClient: vi.fn(), logout: vi.fn() },
	kv: new Map<string, unknown>(),
	session: { hasPersistedSession: vi.fn(), persistSession: vi.fn() },
	fetchAccount: vi.fn(),
	setQueryData: vi.fn(),
	bridge: { current: undefined as object | undefined }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/lib/sdk/session", () => session)
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => bridge.current }))
vi.mock("@/lib/storage/adapter", () => ({
	kvHas: (key: string) => Promise.resolve(kv.has(key)),
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, value)

		return Promise.resolve()
	}
}))
vi.mock("@/queries/client", () => ({ queryClient: { setQueryData } }))
vi.mock("@/queries/account", () => ({ ACCOUNT_QUERY_KEY: ["account"], fetchAccount }))
vi.mock("@/features/notes/lib/preferences", () => ({ DEFAULT_NOTE_TYPE_KV_KEY: "notes.defaultType.v1" }))
vi.mock("@/features/settings/lib/remoteConfig", () => ({ DISMISSED_ANNOUNCEMENTS_KV_KEY: "remoteConfig.dismissedAnnouncements.v1" }))

import { runLegacyWebMigration, wipeLegacyWebOnSignOut } from "@/lib/legacyWebMigration"
import { LEGACY_KEEP_MS, readLegacyMarker, writeLegacyMarker } from "@/lib/legacyWebMigration.logic"

const ROOT = "00000000-0000-4000-8000-000000000001"

// Fixtures only: shaped like the old client's values, with made-up content.
const SDK_CONFIG = {
	email: "user@example.com",
	password: "redacted",
	masterKeys: ["first-master-key"],
	apiKey: "a".repeat(64),
	publicKey: "public-key",
	privateKey: "private-key",
	authVersion: 2,
	baseFolderUUID: ROOT,
	userId: 123456
}

const SESSION = {
	email: "user@example.com",
	rootUuid: ROOT,
	authInfo: "first-master-key",
	privateKey: "private-key",
	apiKey: "a".repeat(64),
	userId: 123456n,
	authVersion: 2
}

const ACCOUNT = { email: "user@example.com" }

let store: Map<string, string>
let cookie: string
let idbOutcome: "success" | "blocked"
let deletedDatabases: string[]

function seedOldSession(config: object = SDK_CONFIG): void {
	store.set("authed:4:4:4", "true")
	store.set("sdkConfig:4:4", JSON.stringify(config))
	store.set("desktopConfig:4:4", JSON.stringify({ sdkConfig: config }))
	store.set("lockPin", '"1234"')
}

function sdkError(kind: string) {
	return { species: "sdk", kind, label: kind, message: kind }
}

beforeEach(() => {
	store = new Map()
	cookie = "theme=dark"
	idbOutcome = "success"
	deletedDatabases = []
	kv.clear()
	bridge.current = undefined
	sdkApi.injectClient.mockResolvedValue(undefined)
	sdkApi.logout.mockResolvedValue(undefined)
	session.hasPersistedSession.mockResolvedValue(false)
	session.persistSession.mockResolvedValue(undefined)
	fetchAccount.mockResolvedValue(ACCOUNT)

	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size
		}
	})
	vi.stubGlobal("navigator", { onLine: true })
	vi.stubGlobal("document", {
		get cookie() {
			return cookie
		},
		set cookie(value: string) {
			cookie = value
		}
	})
	vi.stubGlobal("indexedDB", {
		deleteDatabase: (name: string) => {
			const request: Record<string, (() => void) | undefined> = {}

			deletedDatabases.push(name)
			queueMicrotask(() => {
				request[`on${idbOutcome}`]?.()
			})

			return request
		}
	})
})

// The wipe runs behind the boot; let it settle.
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

describe("runLegacyWebMigration", () => {
	it("costs nothing without the previous app's data", async () => {
		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		expect(sdkApi.injectClient).not.toHaveBeenCalled()
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("imports, verifies with one account read that seeds the account query, saves, and keeps the old copies", async () => {
		seedOldSession()

		await expect(runLegacyWebMigration(1000)).resolves.toBe(true)

		expect(sdkApi.injectClient).toHaveBeenCalledWith(SESSION)
		expect(fetchAccount).toHaveBeenCalledTimes(1)
		expect(setQueryData).toHaveBeenCalledWith(["account"], ACCOUNT)
		expect(session.persistSession).toHaveBeenCalledWith(SESSION)
		expect(readLegacyMarker()).toMatchObject({ stage: "imported", at: 1000, verified: true, attempts: 1 })
		await settle()
		// The query cache holds no session and goes at once; the session copies stay.
		expect(deletedDatabases).toEqual(["Filen_reactQuery"])
		expect(store.has("sdkConfig:4:4")).toBe(true)
	})

	it("continues unverified while offline and is verified by a later account read", async () => {
		seedOldSession()
		vi.stubGlobal("navigator", { onLine: false })

		await expect(runLegacyWebMigration(1000)).resolves.toBe(true)

		expect(fetchAccount).not.toHaveBeenCalled()
		expect(session.persistSession).toHaveBeenCalledTimes(1)
		expect(readLegacyMarker()).toMatchObject({ stage: "imported", verified: false })
	})

	it("continues unverified on a network failure", async () => {
		seedOldSession()
		fetchAccount.mockRejectedValue(sdkError("Reqwest"))

		await expect(runLegacyWebMigration(1000)).resolves.toBe(true)
		expect(readLegacyMarker()).toMatchObject({ stage: "imported", verified: false })
	})

	it("imports nothing from a session the server refuses, and wipes it at once", async () => {
		seedOldSession()
		fetchAccount.mockRejectedValue(sdkError("Unauthenticated"))

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		await settle()

		expect(sdkApi.logout).toHaveBeenCalledTimes(1)
		expect(session.persistSession).not.toHaveBeenCalled()
		expect(store.has("sdkConfig:4:4")).toBe(false)
		expect(store.has("lockPin")).toBe(false)
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("drops a session the SDK rejects", async () => {
		seedOldSession()
		sdkApi.injectClient.mockRejectedValue(sdkError("Conversion"))

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		await settle()

		expect(fetchAccount).not.toHaveBeenCalled()
		expect(store.has("authed:4:4:4")).toBe(false)
	})

	it("drops an invalid config without touching the SDK", async () => {
		seedOldSession({ ...SDK_CONFIG, apiKey: "anonymous" })

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		await settle()

		expect(sdkApi.injectClient).not.toHaveBeenCalled()
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("retries another failure on later starts, then gives up", async () => {
		seedOldSession()
		fetchAccount.mockRejectedValue(sdkError("Server"))

		for (let attempt = 1; attempt <= 3; attempt++) {
			await expect(runLegacyWebMigration(1000 + attempt)).resolves.toBe(false)
			expect(readLegacyMarker()).toMatchObject({ stage: "pending", attempts: attempt })
		}

		await expect(runLegacyWebMigration(2000)).resolves.toBe(false)
		await settle()
		expect(sdkApi.injectClient).toHaveBeenCalledTimes(3)
		expect(sdkApi.logout).toHaveBeenCalledTimes(3)
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("never imports over a session this app already holds", async () => {
		seedOldSession()
		session.hasPersistedSession.mockResolvedValue(true)

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		await settle()

		expect(sdkApi.injectClient).not.toHaveBeenCalled()
		expect(store.has("sdkConfig:4:4")).toBe(false)
	})

	it("treats a session found after an attempt as the import, saved before the page died", async () => {
		seedOldSession()
		writeLegacyMarker({ stage: "pending", attempts: 1, at: 500 })
		session.hasPersistedSession.mockResolvedValue(true)

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)

		expect(sdkApi.injectClient).not.toHaveBeenCalled()
		expect(readLegacyMarker()).toMatchObject({ stage: "imported", at: 1000, verified: false })
		expect(store.has("sdkConfig:4:4")).toBe(true)
	})

	it("never imports again after a sign-out", async () => {
		seedOldSession()
		await runLegacyWebMigration(1000)
		await wipeLegacyWebOnSignOut()
		sdkApi.injectClient.mockClear()
		// An open previous-app tab writes its session back.
		seedOldSession()

		await expect(runLegacyWebMigration(2000)).resolves.toBe(false)
		await settle()

		expect(sdkApi.injectClient).not.toHaveBeenCalled()
		expect(store.has("sdkConfig:4:4")).toBe(false)
	})

	it("wipes every trace seven days after the import, the theme cookie included, and never the referral cookies", async () => {
		seedOldSession()
		store.set("driveSortBy", "{}")
		store.set("conversationParticipantsContainerOpen:abc", "true")
		store.set("filen.language", "de")
		await runLegacyWebMigration(1000)
		await settle()
		deletedDatabases = []

		await runLegacyWebMigration(1000 + LEGACY_KEEP_MS - 1)
		await settle()
		expect(store.has("sdkConfig:4:4")).toBe(true)

		cookie = "theme=dark"
		await runLegacyWebMigration(1000 + LEGACY_KEEP_MS)
		await settle()

		expect([...store.keys()].sort()).toEqual(["filen.language", "filen.legacyWebMigration.v1"])
		expect(deletedDatabases.sort()).toEqual(["Filen", "Filen_reactQuery"])
		expect(cookie).toBe("theme=; Max-Age=0; path=/")
		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("retries a database another tab holds open on a later start", async () => {
		seedOldSession()
		store.set("authed:4:4:4", "false")
		idbOutcome = "blocked"

		await runLegacyWebMigration(1000)
		await settle()

		expect(store.has("sdkConfig:4:4")).toBe(false)
		expect(readLegacyMarker()?.stage).toBe("retired")

		idbOutcome = "success"
		await runLegacyWebMigration(2000)
		await settle()

		expect(readLegacyMarker()).toEqual({ stage: "done" })
	})

	it("imports the settings verbatim, only where this app has none", async () => {
		seedOldSession()
		store.set("defaultNoteType", JSON.stringify("md"))
		store.set("driveSortBy", JSON.stringify({ [ROOT]: "sizeDesc" }))
		store.set("listType", JSON.stringify({ [ROOT]: "grid" }))
		store.set("dismissedAnnouncements", JSON.stringify(["x"]))
		kv.set("drive.viewModePreferences.v1", { mode: "global", global: "list", perDirectory: {} })

		await runLegacyWebMigration(1000)

		expect(kv.get("notes.defaultType.v1")).toBe("md")
		expect(kv.get("drive.sortPreferences.v1")).toEqual({
			mode: "perDirectory",
			global: "nameAsc",
			perDirectory: { "drive:": "sizeDesc" }
		})
		expect(kv.get("drive.viewModePreferences.v1")).toEqual({ mode: "global", global: "list", perDirectory: {} })
		expect(kv.get("remoteConfig.dismissedAnnouncements.v1")).toEqual(["x"])
	})

	it("imports the settings of a signed-out user too", async () => {
		store.set("authed:4:4:4", "false")
		store.set("defaultNoteType", JSON.stringify("rich"))

		await runLegacyWebMigration(1000)

		expect(kv.get("notes.defaultType.v1")).toBe("rich")
		expect(sdkApi.injectClient).not.toHaveBeenCalled()
	})

	it("lets a second tab that waited for the lock find the first one's import", async () => {
		seedOldSession()
		let tail = Promise.resolve()
		const request = vi.fn((_name: string, fn: () => Promise<unknown>) => {
			const run = tail.then(fn)

			tail = run.then(
				() => undefined,
				() => undefined
			)

			return run
		})

		vi.stubGlobal("navigator", { onLine: true, locks: { request } })
		session.hasPersistedSession.mockResolvedValueOnce(false).mockResolvedValue(true)

		const [first, second] = await Promise.all([runLegacyWebMigration(1000), runLegacyWebMigration(1000)])

		expect([first, second]).toEqual([true, false])
		expect(request).toHaveBeenCalledWith("filen.legacyWebMigration", expect.any(Function))
		expect(sdkApi.injectClient).toHaveBeenCalledTimes(1)
	})

	it("is skipped on desktop", async () => {
		seedOldSession()
		bridge.current = {}

		await expect(runLegacyWebMigration(1000)).resolves.toBe(false)
		await expect(wipeLegacyWebOnSignOut()).resolves.toBeUndefined()
		expect(store.has("sdkConfig:4:4")).toBe(true)
		expect(readLegacyMarker()).toBeNull()
	})
})
