import { describe, expect, it, vi } from "vitest"
import type { AtomicFile } from "../main/atomicFile.ts"
import { LEGACY_KEYS } from "../main/legacyData.ts"
import {
	createMigration,
	MAX_FAILED_STARTS,
	type MigrationDeps,
	type MigrationMarker,
	parseMarker,
	serializeMarker,
	startupDecision,
	verifiedBy,
	waitExpired,
	WIPE_AFTER_MS
} from "../main/migration.ts"
import type { SessionRead } from "../shared/channels.ts"

const DAY = 24 * 60 * 60 * 1000

function marker(overrides: Partial<MigrationMarker> = {}): MigrationMarker {
	return {
		stage: "imported",
		failedStarts: 1,
		startedAt: 0,
		stashOnly: false,
		userId: 123456,
		importedAt: 0,
		wiped: false,
		purged: false,
		...overrides
	}
}

const SESSION_OF = (userId: string) => JSON.stringify({ userId: `$bigint:${userId}n` })

describe("parseMarker", () => {
	it("round-trips a marker", () => {
		const value = marker({ stage: "verified", wiped: true })

		expect(parseMarker(serializeMarker(value))).toEqual(value)
	})

	it("reads anything unusable as no marker", () => {
		expect(parseMarker(null)).toBeNull()
		expect(parseMarker("{")).toBeNull()
		expect(parseMarker(JSON.stringify({ version: 2, ...marker() }))).toBeNull()
		expect(parseMarker(JSON.stringify({ version: 1, ...marker({ stage: "done" as "imported" }) }))).toBeNull()
		expect(parseMarker(JSON.stringify({ version: 1, ...marker({ userId: 1 }) }))).toBeNull()
	})

	it("reads a marker written before purging existed as not purged", () => {
		const { purged: _purged, ...older } = marker({ stage: "verified", wiped: true })

		expect(parseMarker(JSON.stringify({ version: 1, ...older }))?.purged).toBe(false)
	})

	it("reads a marker written before the first attempt's time and the stash-only mode existed", () => {
		const { startedAt: _startedAt, stashOnly: _stashOnly, ...older } = marker({ stage: "started" })

		expect(parseMarker(JSON.stringify({ version: 1, ...older }))).toMatchObject({ startedAt: null, stashOnly: false })
	})
})

describe("startupDecision", () => {
	it("decides afresh without a marker", () => {
		expect(startupDecision(null, false, "absent")).toBe("skip-fresh")
		expect(startupDecision(null, true, "present")).toBe("stash")
		expect(startupDecision(null, true, "unreadable")).toBe("defer")
		expect(startupDecision(null, true, "absent")).toBe("run")
	})

	it("retries a started attempt until it failed too often, whatever the vault holds", () => {
		const started = marker({ stage: "started", failedStarts: 1 })

		expect(startupDecision(started, true, "present")).toBe("run")
		expect(startupDecision(started, true, "absent")).toBe("run")
		expect(startupDecision(started, true, "unreadable")).toBe("defer")
		expect(startupDecision({ ...started, failedStarts: MAX_FAILED_STARTS }, true, "absent")).toBe("abandon")
	})

	it("keeps a stash-only attempt stash-only on a rerun, whatever the vault holds now", () => {
		const started = marker({ stage: "started", stashOnly: true })

		expect(startupDecision(started, true, "absent")).toBe("stash")
		expect(startupDecision(started, true, "unreadable")).toBe("stash")
		expect(startupDecision({ ...started, failedStarts: MAX_FAILED_STARTS }, true, "present")).toBe("abandon")
	})

	it("never imports again once imported, abandoned or skipped", () => {
		for (const stage of ["imported", "abandoned", "verified", "skipped"] as const) {
			expect(startupDecision(marker({ stage }), true, "absent")).toBe("none")
		}
	})
})

describe("waitExpired", () => {
	it("expires at once without an account, else after the time limit", () => {
		expect(waitExpired(marker({ userId: null }), 0)).toBe(true)
		expect(waitExpired(marker({ importedAt: 0 }), WIPE_AFTER_MS - 1)).toBe(false)
		expect(waitExpired(marker({ importedAt: 0 }), WIPE_AFTER_MS)).toBe(true)
		expect(waitExpired(marker({ importedAt: 10 * DAY }), 0)).toBe(false)
		expect(waitExpired(marker({ stage: "verified" }), WIPE_AFTER_MS)).toBe(false)
	})

	it("expires an abandoned import the time limit after its first attempt", () => {
		const abandoned = marker({ stage: "abandoned", userId: null, importedAt: null, startedAt: DAY })

		expect(waitExpired(abandoned, DAY + WIPE_AFTER_MS - 1)).toBe(false)
		expect(waitExpired(abandoned, DAY + WIPE_AFTER_MS)).toBe(true)
		expect(waitExpired(abandoned, 0)).toBe(false)
		expect(waitExpired(marker({ stage: "started", startedAt: 0 }), WIPE_AFTER_MS)).toBe(false)
	})
})

describe("verifiedBy", () => {
	it("takes only a session of the migrated account", () => {
		expect(verifiedBy(marker(), SESSION_OF("123456"))).toBe(true)
		expect(verifiedBy(marker(), SESSION_OF("777"))).toBe(false)
		expect(verifiedBy(marker(), null)).toBe(false)
		expect(verifiedBy(marker({ userId: null }), SESSION_OF("123456"))).toBe(false)
		expect(verifiedBy(marker({ stage: "started" }), SESSION_OF("123456"))).toBe(false)
	})
})

const SDK_CONFIG = {
	email: "user@example.com",
	masterKeys: ["master-key"],
	apiKey: "a".repeat(64),
	privateKey: "private-key",
	authVersion: 2,
	baseFolderUUID: "root-uuid",
	userId: 123456
}

function legacyRead(values: Record<string, unknown>) {
	const raw = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]))

	return { count: Object.keys(raw).length + 5, values: raw }
}

const SIGNED_IN = {
	[LEGACY_KEYS.authed]: true,
	[LEGACY_KEYS.sdkConfig]: SDK_CONFIG,
	[LEGACY_KEYS.lockPin]: "4321",
	[LEGACY_KEYS.lockTimeout]: 600,
	[LEGACY_KEYS.minimizeToTray]: true,
	[LEGACY_KEYS.sync]: { "123456": { syncPairs: [] } }
}

function memoryFile(initial: string | null = null): AtomicFile & { text: () => string | null } {
	let data: Buffer | null = initial === null ? null : Buffer.from(initial)

	return {
		text: () => data?.toString() ?? null,
		read: () => Promise.resolve(data),
		write: buffer => {
			data = buffer

			return Promise.resolve()
		},
		remove: () => {
			data = null

			return Promise.resolve()
		}
	}
}

function setup(
	options: { marker?: MigrationMarker | undefined; read?: unknown; vault?: SessionRead; legacyProfile?: boolean; now?: number } = {}
) {
	const markerFile = memoryFile(options.marker === undefined ? null : serializeMarker(options.marker))
	const state = { vault: options.vault ?? ({ status: "absent" } as SessionRead), lockEnabled: false, now: options.now ?? 1000 }
	const deps = {
		marker: markerFile,
		legacyProfile: vi.fn(() => Promise.resolve(options.legacyProfile ?? true)),
		readLegacy: vi.fn(() => Promise.resolve(options.read ?? legacyRead(SIGNED_IN))),
		readOptions: vi.fn(() => Promise.resolve<string | null>(JSON.stringify({ startMinimized: true }))),
		wipeLegacy: vi.fn(() => Promise.resolve()),
		removeRcloneConfig: vi.fn(() => Promise.resolve()),
		purgeLegacyStores: vi.fn(() => Promise.resolve()),
		vault: {
			get: vi.fn(() => Promise.resolve(state.vault)),
			set: vi.fn((blob: string) => {
				state.vault = { status: "present", blob }

				return Promise.resolve()
			})
		},
		lock: {
			enabled: () => state.lockEnabled,
			set: vi.fn(() => {
				state.lockEnabled = true

				return Promise.resolve(true)
			})
		},
		prefs: { set: vi.fn(() => Promise.resolve()) },
		launchesAtLogin: vi.fn(() => false),
		applyLaunchAtLogin: vi.fn(() => Promise.resolve()),
		writeStash: vi.fn((_text: string) => Promise.resolve()),
		now: () => state.now,
		info: vi.fn(),
		warn: vi.fn()
	} satisfies MigrationDeps

	return { deps, state, markerFile, migration: createMigration(deps), stored: () => parseMarker(markerFile.text()) }
}

// The wipe runs in the background after start; this lets it finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe("createMigration", () => {
	it("imports the session, stash, PIN and prefs, then waits for verification", async () => {
		const { deps, migration, stored } = setup()

		await expect(migration.start()).resolves.toEqual({ pinImported: true })
		await settle()

		expect(deps.vault.set).toHaveBeenCalledTimes(1)
		expect(JSON.parse(deps.vault.set.mock.calls[0]?.[0] ?? "")).toMatchObject({ userId: "$bigint:123456n", authInfo: "master-key" })
		expect(deps.lock.set).toHaveBeenCalledWith("4321")
		expect(deps.prefs.set).toHaveBeenCalledWith({ minimizeToTray: true, startMinimized: true })
		expect(JSON.parse(deps.writeStash.mock.calls[0]?.[0] ?? "")).toMatchObject({ userId: 123456 })
		expect(deps.wipeLegacy).not.toHaveBeenCalled()
		expect(deps.removeRcloneConfig).toHaveBeenCalledTimes(1)
		expect(stored()).toEqual({
			stage: "imported",
			failedStarts: 1,
			startedAt: 1000,
			stashOnly: false,
			userId: 123456,
			importedAt: 1000,
			wiped: false,
			purged: false
		})
	})

	it("logs counts and reasons, never a value", async () => {
		const { deps, migration } = setup()

		await migration.start()

		const logged = [...deps.info.mock.calls, ...deps.warn.mock.calls].flat().join("\n")

		expect(logged).toContain("keys=11")
		expect(logged).not.toContain("master-key")
		expect(logged).not.toContain("4321")
		expect(logged).not.toContain("user@example.com")
	})

	it("wipes once the migrated account is confirmed, and only by that account", async () => {
		const { deps, migration, stored } = setup()

		await migration.start()
		await migration.sessionConfirmed(SESSION_OF("777"))
		await settle()
		expect(deps.wipeLegacy).not.toHaveBeenCalled()

		await migration.sessionConfirmed(SESSION_OF("123456"))
		await settle()
		expect(deps.wipeLegacy).toHaveBeenCalledTimes(1)
		expect(stored()).toMatchObject({ stage: "verified", wiped: true })

		await migration.sessionConfirmed(SESSION_OF("123456"))
		await settle()
		expect(deps.wipeLegacy).toHaveBeenCalledTimes(1)
	})

	it("wipes at startup once the time limit passed", async () => {
		const { deps, migration, stored } = setup({ marker: marker({ importedAt: 0 }), now: WIPE_AFTER_MS })

		await migration.start()
		await settle()

		expect(deps.readLegacy).not.toHaveBeenCalled()
		expect(deps.wipeLegacy).toHaveBeenCalledTimes(1)
		expect(stored()).toMatchObject({ stage: "verified", wiped: true })
	})

	it("wipes right after an import without a signed-in account", async () => {
		const { deps, migration, stored } = setup({ read: legacyRead({ [LEGACY_KEYS.authed]: false, [LEGACY_KEYS.webdav]: { "5": {} } }) })

		await expect(migration.start()).resolves.toEqual({ pinImported: false })
		await settle()

		expect(deps.vault.set).not.toHaveBeenCalled()
		expect(deps.lock.set).not.toHaveBeenCalled()
		expect(deps.writeStash).toHaveBeenCalledTimes(1)
		expect(deps.wipeLegacy).toHaveBeenCalledTimes(1)
		expect(stored()).toMatchObject({ stage: "verified", userId: null, wiped: true })
	})

	it("retries a failed wipe on the next launch", async () => {
		const first = setup({ marker: marker({ stage: "verified" }) })

		first.deps.wipeLegacy.mockRejectedValueOnce(new Error("timeout"))
		await first.migration.start()
		await settle()
		expect(first.stored()).toMatchObject({ stage: "verified", wiped: false })

		const second = setup({ marker: first.stored() ?? undefined })

		await second.migration.start()
		await settle()
		expect(second.deps.removeRcloneConfig).toHaveBeenCalledTimes(1)
		expect(second.deps.wipeLegacy).toHaveBeenCalledTimes(1)
		expect(second.stored()).toMatchObject({ wiped: true })
	})

	it("treats a read with no keys as failed: nothing imported, retried, then given up", async () => {
		let current: MigrationMarker | undefined

		for (let attempt = 1; attempt <= MAX_FAILED_STARTS; attempt++) {
			const run = setup({ marker: current, read: { count: 0, values: {} }, now: attempt * DAY })

			await run.migration.start()
			expect(run.deps.vault.set).not.toHaveBeenCalled()
			expect(run.deps.wipeLegacy).not.toHaveBeenCalled()
			expect(run.deps.removeRcloneConfig).not.toHaveBeenCalled()
			current = run.stored() ?? undefined
			expect(current).toMatchObject({ stage: "started", failedStarts: attempt, startedAt: DAY })
		}

		const last = setup({ marker: current, now: 4 * DAY })

		await last.migration.start()
		await settle()
		expect(last.deps.readLegacy).not.toHaveBeenCalled()
		expect(last.deps.removeRcloneConfig).toHaveBeenCalledTimes(1)
		expect(last.deps.wipeLegacy).not.toHaveBeenCalled()
		expect(last.stored()).toMatchObject({ stage: "abandoned", startedAt: DAY })
	})

	it("still wipes a given-up import, the time limit after its first attempt", async () => {
		const abandoned = marker({ stage: "abandoned", failedStarts: MAX_FAILED_STARTS, userId: null, importedAt: null, startedAt: DAY })
		const early = setup({ marker: abandoned, now: DAY + WIPE_AFTER_MS - 1 })

		await early.migration.start()
		await settle()
		expect(early.deps.wipeLegacy).not.toHaveBeenCalled()
		expect(early.stored()).toEqual(abandoned)

		const due = setup({ marker: abandoned, now: DAY + WIPE_AFTER_MS })

		await due.migration.start()
		await settle()
		expect(due.deps.readLegacy).not.toHaveBeenCalled()
		expect(due.deps.wipeLegacy).toHaveBeenCalledTimes(1)
		expect(due.stored()).toMatchObject({ stage: "verified", wiped: true })
	})

	it("imports only the stash over a session stored before it, and wipes later", async () => {
		const { deps, migration, stored } = setup({ vault: { status: "present", blob: SESSION_OF("777") } })

		deps.launchesAtLogin.mockReturnValue(true)

		await expect(migration.start()).resolves.toEqual({ pinImported: false })
		await settle()

		expect(deps.vault.set).not.toHaveBeenCalled()
		expect(deps.lock.set).not.toHaveBeenCalled()
		expect(deps.prefs.set).not.toHaveBeenCalled()
		expect(deps.applyLaunchAtLogin).not.toHaveBeenCalled()
		expect(deps.writeStash).toHaveBeenCalledTimes(1)
		expect(deps.removeRcloneConfig).toHaveBeenCalledTimes(1)
		expect(deps.wipeLegacy).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ stage: "imported", stashOnly: true, userId: 123456 })
	})

	it("stays stash-only when rerun after a crash, even once the vault is empty", async () => {
		const { deps, migration, stored } = setup({
			marker: marker({ stage: "started", stashOnly: true, userId: null, importedAt: null }),
			vault: { status: "absent" }
		})

		await migration.start()

		expect(deps.vault.set).not.toHaveBeenCalled()
		expect(deps.lock.set).not.toHaveBeenCalled()
		expect(deps.prefs.set).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ stage: "imported", stashOnly: true, failedStarts: 2 })
	})

	it("skips a fresh install and does nothing more after", async () => {
		const first = setup({ legacyProfile: false })

		await first.migration.start()
		expect(first.deps.vault.get).not.toHaveBeenCalled()
		expect(first.deps.removeRcloneConfig).not.toHaveBeenCalled()
		expect(first.stored()).toMatchObject({ stage: "skipped" })

		const second = setup({ marker: first.stored() ?? undefined })

		await second.migration.start()
		expect(second.deps.legacyProfile).not.toHaveBeenCalled()
		expect(second.deps.vault.get).not.toHaveBeenCalled()
	})

	it("defers without writing anything while the vault cannot be read", async () => {
		const { deps, migration, markerFile } = setup({ vault: { status: "unreadable" } })

		await migration.start()

		expect(deps.readLegacy).not.toHaveBeenCalled()
		expect(markerFile.text()).toBeNull()
	})

	it("reruns after a crash without replacing the session the earlier attempt stored", async () => {
		const { deps, migration, stored } = setup({
			marker: marker({ stage: "started", failedStarts: 1, userId: null, importedAt: null }),
			vault: { status: "present", blob: SESSION_OF("123456") }
		})

		await migration.start()

		expect(deps.vault.set).not.toHaveBeenCalled()
		expect(deps.writeStash).toHaveBeenCalledTimes(1)
		expect(stored()).toMatchObject({ stage: "imported", failedStarts: 2, userId: 123456 })
	})

	it("leaves a PIN set in this app alone", async () => {
		const { deps, state, migration } = setup()

		state.lockEnabled = true

		await expect(migration.start()).resolves.toEqual({ pinImported: false })
		expect(deps.lock.set).not.toHaveBeenCalled()
	})

	it("carries launch at login and keeps it when re-registering fails", async () => {
		const { deps, migration, stored } = setup()

		deps.launchesAtLogin.mockReturnValue(true)
		deps.applyLaunchAtLogin.mockRejectedValueOnce(new Error("denied"))

		await migration.start()

		expect(deps.prefs.set).toHaveBeenCalledWith({ minimizeToTray: true, startMinimized: true, launchAtLogin: true })
		expect(deps.applyLaunchAtLogin).toHaveBeenCalledWith(true)
		expect(stored()).toMatchObject({ stage: "imported" })
	})

	it("stays retryable when storing the session fails", async () => {
		const { deps, migration, stored } = setup()

		deps.vault.set.mockRejectedValueOnce(new Error("keychain"))

		await expect(migration.start()).resolves.toEqual({ pinImported: false })
		expect(deps.writeStash).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ stage: "started", failedStarts: 1 })
	})
})

describe("failure logging", () => {
	it("names the reason of a failed read", async () => {
		const { deps, migration } = setup({ read: { count: 0, values: {} } })

		await migration.start()

		expect(deps.warn).toHaveBeenCalledWith("migration: failed: no keys")
	})
})

describe("purging the old stores", () => {
	const SIGNED_IN_VAULT: SessionRead = { status: "present", blob: SESSION_OF("123456") }

	it("deletes them on the launch after the wipe, once", async () => {
		const first = setup({ marker: marker({ stage: "verified", wiped: true }), vault: SIGNED_IN_VAULT })

		await first.migration.start()

		expect(first.deps.purgeLegacyStores).toHaveBeenCalledTimes(1)
		expect(first.stored()).toMatchObject({ wiped: true, purged: true })

		const second = setup({ marker: first.stored() ?? undefined, vault: SIGNED_IN_VAULT })

		await second.migration.start()

		expect(second.deps.purgeLegacyStores).not.toHaveBeenCalled()
	})

	it("never deletes them before the secrets were wiped", async () => {
		const run = setup({ marker: marker({ stage: "verified", wiped: false }) })

		await run.migration.start()

		expect(run.deps.purgeLegacyStores).not.toHaveBeenCalled()
	})

	it("waits for a launch with a stored session, so a sign-out cut short keeps the page's flag", async () => {
		for (const vault of [{ status: "absent" }, { status: "unreadable" }] as const) {
			const run = setup({ marker: marker({ stage: "verified", wiped: true }), vault })

			await run.migration.start()

			expect(run.deps.purgeLegacyStores).not.toHaveBeenCalled()
			expect(run.stored()).toMatchObject({ purged: false })
		}
	})

	it("tries again next launch when deleting fails, logging it once", async () => {
		const run = setup({ marker: marker({ stage: "verified", wiped: true }), vault: SIGNED_IN_VAULT })

		run.deps.purgeLegacyStores.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
		await expect(run.migration.start()).resolves.toEqual({ pinImported: false })

		expect(run.deps.warn).toHaveBeenCalledTimes(1)
		expect(run.deps.warn).toHaveBeenCalledWith("migration: deleting the old stores failed, tried again next launch: EBUSY")
		expect(run.stored()).toMatchObject({ purged: false })
	})
})
