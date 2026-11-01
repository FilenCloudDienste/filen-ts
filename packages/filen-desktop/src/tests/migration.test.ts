import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { type AtomicFile, codedError } from "../main/atomicFile.ts"
import { LEGACY_KEYS, type LegacyStash } from "../main/legacyData.ts"
import { deleteLegacyStores, LEGACY_INDEXEDDB_PREFIX, legacyProfileExists } from "../main/legacyOrigin.ts"
import {
	createMigration,
	createStashStore,
	legacyLogsDir,
	legacyOwner,
	MAX_FAILED_STARTS,
	type MigrationDeps,
	type MigrationMarker,
	parseMarker,
	type PurgeDeps,
	type PurgeOutcome,
	purgeBeforeReady,
	serializeMarker,
	startupDecision,
	verifiedBy,
	waitExpired,
	WIPE_AFTER_MS,
	withoutFeature
} from "../main/migration.ts"
import type { VaultCipher } from "../main/sessionVault.ts"
import { removeTree } from "../main/signOut.ts"
import { applyLegacySync, LEGACY_BUILTIN_RULES, type LegacySyncDeps } from "../main/sync/legacyPairs.ts"
import type { SessionRead } from "../shared/channels.ts"
import { fakeNative, memoryStore, Refusal } from "./syncFakes.ts"

const DAY = 24 * 60 * 60 * 1000

function marker(overrides: Partial<MigrationMarker> = {}): MigrationMarker {
	return {
		stage: "imported",
		failedStarts: 1,
		startedAt: 0,
		stashOnly: false,
		volatileStash: false,
		userId: 123456,
		importedAt: 0,
		wiped: false,
		purged: false,
		logsDeleted: false,
		...overrides
	}
}

const SESSION_OF = (userId: string) =>
	JSON.stringify({
		email: "user@example.com",
		userId: `$bigint:${userId}n`,
		rootUuid: "root-uuid",
		authInfo: "auth-info",
		privateKey: "private-key",
		apiKey: "api-key",
		authVersion: 2
	})

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

	it("reads a marker written before deleting the old logs existed as not deleted", () => {
		const { logsDeleted: _logsDeleted, ...older } = marker({ stage: "verified", wiped: true, purged: true })

		expect(parseMarker(JSON.stringify({ version: 1, ...older }))?.logsDeleted).toBe(false)
	})

	it("reads a marker written before the first attempt's time and the stash-only mode existed", () => {
		const { startedAt: _startedAt, stashOnly: _stashOnly, ...older } = marker({ stage: "started" })

		expect(parseMarker(JSON.stringify({ version: 1, ...older }))).toMatchObject({ startedAt: null, stashOnly: false })
	})
})

describe("legacyOwner", () => {
	it("is known once the import got that far", () => {
		expect(legacyOwner(null)).toBeUndefined()
		expect(legacyOwner(marker({ stage: "started" }))).toBeUndefined()
		expect(legacyOwner(marker({ stage: "imported", userId: 42 }))).toBe("42")
		expect(legacyOwner(marker({ stage: "verified", userId: 42 }))).toBe("42")
		expect(legacyOwner(marker({ stage: "imported", userId: null }))).toBeNull()
		expect(legacyOwner(marker({ stage: "abandoned" }))).toBeNull()
		expect(legacyOwner(marker({ stage: "skipped" }))).toBeNull()
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

	it("skips a started attempt without the old profile, however often it failed", () => {
		const started = marker({ stage: "started", failedStarts: 1, userId: null, importedAt: null })

		expect(startupDecision(started, false, "absent")).toBe("skip-fresh")
		expect(startupDecision({ ...started, stashOnly: true }, false, "absent")).toBe("skip-fresh")
		expect(startupDecision({ ...started, failedStarts: MAX_FAILED_STARTS }, false, "absent")).toBe("skip-fresh")
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
			expect(startupDecision(marker({ stage }), false, "absent")).toBe("none")
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
		removeLegacyLogs: vi.fn(() => Promise.resolve()),
		earlyPurge: vi.fn((): PurgeOutcome => ({ result: "not-due" })),
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
		writeStash: vi.fn((_text: string) => Promise.resolve(true)),
		now: () => state.now,
		info: vi.fn(),
		warn: vi.fn()
	} satisfies MigrationDeps

	return { deps, state, markerFile, migration: createMigration(deps), stored: () => parseMarker(markerFile.text()) }
}

type Deps = ReturnType<typeof setup>["deps"]

// The wipe runs in the background after start; this lets it finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe("createMigration", () => {
	it("without secure storage, reads the stash again on every launch, never giving up, until the wait ran out", async () => {
		const first = setup()

		first.deps.writeStash.mockResolvedValue(false)
		await first.migration.start()

		expect(first.stored()).toMatchObject({ stage: "started", failedStarts: 0, stashOnly: true, volatileStash: true, userId: 123456 })
		// Its pairs and mounts are applied for the account it read.
		expect(legacyOwner(first.stored())).toBe("123456")

		for (let launch = 0; launch < MAX_FAILED_STARTS + 1; launch++) {
			const next = setup({ marker: first.stored() ?? undefined, now: 1000 + launch })

			next.deps.writeStash.mockResolvedValue(false)
			await next.migration.start()

			// The stash only: the session, PIN and prefs were imported the first time.
			expect(next.deps.writeStash).toHaveBeenCalledTimes(1)
			expect(next.deps.prefs.set).not.toHaveBeenCalled()
			expect(next.stored()).toMatchObject({ stage: "started", failedStarts: 0 })
		}

		const late = setup({ marker: first.stored() ?? undefined, now: 1000 + WIPE_AFTER_MS })

		late.deps.writeStash.mockResolvedValue(false)
		await late.migration.start()
		expect(late.stored()).toMatchObject({ stage: "imported", volatileStash: false })
	})

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
			volatileStash: false,
			userId: 123456,
			importedAt: 1000,
			wiped: false,
			purged: false,
			logsDeleted: false
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

	it("deletes the old logs only once the secrets are wiped, and records it", async () => {
		const { deps, migration, stored } = setup()

		await migration.start()
		await settle()
		expect(deps.removeLegacyLogs).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ stage: "imported", logsDeleted: false })

		await migration.sessionConfirmed(SESSION_OF("123456"))
		await settle()
		expect(deps.removeLegacyLogs).toHaveBeenCalledTimes(1)
		expect(deps.wipeLegacy.mock.invocationCallOrder[0]).toBeLessThan(deps.removeLegacyLogs.mock.invocationCallOrder[0] ?? 0)
		expect(stored()).toMatchObject({ stage: "verified", wiped: true, logsDeleted: true })
		expect(deps.info).toHaveBeenCalledWith("migration: the old client's logs were deleted")

		const next = setup({ marker: stored() ?? undefined })

		await next.migration.start()
		await settle()
		expect(next.deps.removeLegacyLogs).not.toHaveBeenCalled()
	})

	it("never deletes the old logs when the wipe failed", async () => {
		const { deps, migration, stored } = setup({ marker: marker({ stage: "verified" }) })

		deps.wipeLegacy.mockRejectedValueOnce(new Error("timeout"))
		await migration.start()
		await settle()
		expect(deps.removeLegacyLogs).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ wiped: false, logsDeleted: false })
	})

	it("keeps the wipe when the old logs cannot be deleted, logs the code and deletes them on the next launch", async () => {
		const first = setup({ marker: marker({ stage: "verified" }) })

		first.deps.removeLegacyLogs.mockRejectedValueOnce(Object.assign(new Error("resource busy or locked"), { code: "EBUSY" }))
		await first.migration.start()
		await settle()
		expect(first.stored()).toMatchObject({ wiped: true, logsDeleted: false })
		expect(first.deps.warn).toHaveBeenCalledWith("migration: deleting the old logs failed, tried again next launch: EBUSY")

		const second = setup({ marker: first.stored() ?? undefined })

		await second.migration.start()
		await settle()
		expect(second.deps.wipeLegacy).not.toHaveBeenCalled()
		expect(second.deps.removeLegacyLogs).toHaveBeenCalledTimes(1)
		expect(second.stored()).toMatchObject({ wiped: true, logsDeleted: true })
	})

	it("deletes the old logs of a migration wiped before that step existed", async () => {
		const { logsDeleted: _logsDeleted, ...older } = marker({ stage: "verified", wiped: true, purged: true })
		const run = setup()

		await run.markerFile.write(Buffer.from(JSON.stringify({ version: 1, ...older })))
		await run.migration.start()
		await settle()
		expect(run.deps.removeLegacyLogs).toHaveBeenCalledTimes(1)
		expect(run.stored()).toMatchObject({ logsDeleted: true })
	})

	it("treats a read with no keys from the old profile as missed: nothing imported, retried, then given up", async () => {
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
		expect(first.deps.readLegacy).not.toHaveBeenCalled()
		expect(first.deps.vault.get).not.toHaveBeenCalled()
		expect(first.deps.removeRcloneConfig).not.toHaveBeenCalled()
		expect(first.stored()).toMatchObject({ stage: "skipped" })

		const second = setup({ marker: first.stored() ?? undefined })

		await second.migration.start()
		expect(second.deps.legacyProfile).not.toHaveBeenCalled()
		expect(second.deps.vault.get).not.toHaveBeenCalled()
	})

	it("probes the old web app's IndexedDB, not the Local Storage store every profile has", async () => {
		const userData = await realpath(await mkdtemp(path.join(tmpdir(), "filen-migration-")))

		try {
			await mkdir(path.join(userData, "Local Storage", "leveldb"), { recursive: true })

			const fresh = setup()

			fresh.deps.legacyProfile.mockImplementation(() => legacyProfileExists(userData))
			await fresh.migration.start()
			expect(fresh.deps.readLegacy).not.toHaveBeenCalled()
			expect(fresh.stored()).toMatchObject({ stage: "skipped", failedStarts: 0 })

			await mkdir(path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`), { recursive: true })

			const old = setup()

			old.deps.legacyProfile.mockImplementation(() => legacyProfileExists(userData))
			await old.migration.start()
			expect(old.deps.readLegacy).toHaveBeenCalledTimes(1)
			expect(old.stored()).toMatchObject({ stage: "imported", userId: 123456 })
		} finally {
			await rm(userData, { recursive: true, force: true })
		}
	})

	it("ends an attempt an earlier build started on a fresh install as skipped, reading and wiping nothing", async () => {
		const { deps, migration, stored } = setup({
			marker: marker({ stage: "started", failedStarts: 2, userId: null, importedAt: null }),
			legacyProfile: false
		})

		await migration.start()
		await settle()

		expect(deps.legacyProfile).toHaveBeenCalledTimes(1)
		expect(deps.readLegacy).not.toHaveBeenCalled()
		expect(deps.vault.get).not.toHaveBeenCalled()
		expect(deps.removeRcloneConfig).not.toHaveBeenCalled()
		expect(deps.wipeLegacy).not.toHaveBeenCalled()
		expect(stored()).toMatchObject({ stage: "skipped", failedStarts: 0 })
	})

	it("probes again on a rerun and keeps retrying while the old profile is there", async () => {
		const { deps, migration, stored } = setup({
			marker: marker({ stage: "started", failedStarts: 1, userId: null, importedAt: null }),
			read: { count: 0, values: {} }
		})

		await migration.start()

		expect(deps.legacyProfile).toHaveBeenCalledTimes(1)
		expect(deps.readLegacy).toHaveBeenCalledTimes(1)
		expect(stored()).toMatchObject({ stage: "started", failedStarts: 2 })
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
	// safeStorage's rejection: a plain Error whose message must never reach the log.
	const safeStorageError = () => new Error("Error while encrypting the text provided to safeStorage.encryptStringAsync.")
	const fsError = (code: string) => Object.assign(new Error(`${code}: /home/user/secret path`), { code })

	it("names the reason of a failed read", async () => {
		const { deps, migration } = setup({ read: { count: 0, values: {} } })

		await migration.start()

		expect(deps.warn).toHaveBeenCalledWith("migration: failed: legacy parse: no keys")
	})

	it.each([
		["marker read", (deps: Deps) => vi.spyOn(deps.marker, "read").mockRejectedValueOnce(fsError("EACCES")), "EACCES"],
		["marker write", (deps: Deps) => vi.spyOn(deps.marker, "write").mockRejectedValueOnce(fsError("ENOSPC")), "ENOSPC"],
		["profile probe", (deps: Deps) => deps.legacyProfile.mockRejectedValueOnce(fsError("EPERM")), "EPERM"],
		["vault status", (deps: Deps) => deps.vault.get.mockRejectedValueOnce(new TypeError("value")), "TypeError"],
		["legacy read", (deps: Deps) => deps.readLegacy.mockRejectedValueOnce(new Error("page said user@example.com")), "Error"],
		["legacy parse", (deps: Deps) => deps.readLegacy.mockResolvedValueOnce("not a read result"), "unexpected read result"],
		["session import", (deps: Deps) => deps.vault.set.mockRejectedValueOnce(safeStorageError()), "safeStorage"],
		["session import", (deps: Deps) => deps.vault.set.mockRejectedValueOnce(fsError("ENOSPC")), "ENOSPC"],
		["stash", (deps: Deps) => deps.writeStash.mockRejectedValueOnce(safeStorageError()), "safeStorage"],
		["pin import", (deps: Deps) => deps.lock.set.mockRejectedValueOnce(safeStorageError()), "safeStorage"],
		["prefs import", (deps: Deps) => deps.readOptions.mockRejectedValueOnce(fsError("EISDIR")), "EISDIR"],
		["prefs import", (deps: Deps) => deps.prefs.set.mockRejectedValueOnce(new RangeError("value")), "RangeError"]
	] as const)("names the failed step: %s (%s)", async (step, fail, cause) => {
		const { deps, migration } = setup()

		fail(deps)
		await migration.start()

		expect(deps.warn).toHaveBeenCalledTimes(1)
		expect(deps.warn).toHaveBeenCalledWith(`migration: failed: ${step}: ${cause}`)
	})

	it("names the vault status step when the vault turns unreadable before the import", async () => {
		const { deps, migration } = setup({ marker: marker({ stage: "started", stashOnly: false }) })

		deps.vault.get.mockResolvedValueOnce({ status: "absent" }).mockResolvedValueOnce({ status: "unreadable" })
		await migration.start()

		expect(deps.warn).toHaveBeenCalledWith("migration: failed: vault status: unreadable")
	})

	it.each([
		["rclone config", (deps: Deps) => deps.removeRcloneConfig.mockRejectedValueOnce(fsError("EBUSY")), "EBUSY"],
		["legacy wipe", (deps: Deps) => deps.wipeLegacy.mockRejectedValueOnce(codedError("timeout")), "timeout"],
		["marker write", (deps: Deps) => vi.spyOn(deps.marker, "write").mockRejectedValueOnce(fsError("EROFS")), "EROFS"]
	] as const)("names the failed wipe step: %s", async (step, fail, cause) => {
		const { deps, migration } = setup({ marker: marker({ stage: "verified" }) })

		fail(deps)
		await migration.start()
		await settle()

		expect(deps.warn).toHaveBeenCalledWith(`migration: wipe failed: ${step}: ${cause}`)
	})

	it("names the step of an unrecorded verification", async () => {
		const { deps, migration } = setup({ marker: marker() })

		await migration.start()
		await settle()
		vi.spyOn(deps.marker, "write").mockRejectedValueOnce(fsError("ENOSPC"))
		await migration.sessionConfirmed(SESSION_OF("123456"))

		expect(deps.warn).toHaveBeenCalledWith("migration: verification not recorded: marker write: ENOSPC")
	})

	it("never logs an error's message", async () => {
		const { deps, migration } = setup()

		deps.readLegacy.mockRejectedValueOnce(new Error("page said user@example.com"))
		await migration.start()

		expect(deps.warn.mock.calls.flat().join("\n")).not.toContain("example.com")
	})
})

describe("purging the old stores", () => {
	const WIPED = marker({ stage: "verified", wiped: true })

	function purgeDeps(text: string | null, overrides: Partial<PurgeDeps> = {}) {
		return {
			readMarker: vi.fn(() => text),
			sessionStored: vi.fn(() => true),
			deleteStores: vi.fn(() => undefined),
			...overrides
		} satisfies PurgeDeps
	}

	// One launch: the purge before ready, then the migration after it, as main runs them.
	async function launch(stored: MigrationMarker | null, overrides: Partial<PurgeDeps> = {}) {
		const deps = purgeDeps(stored === null ? null : serializeMarker(stored), overrides)
		const outcome = purgeBeforeReady(deps)
		const run = setup({ marker: stored ?? undefined, vault: { status: "present", blob: SESSION_OF("123456") } })

		run.deps.earlyPurge.mockReturnValue(outcome)
		await expect(run.migration.start()).resolves.toEqual({ pinImported: false })

		return { ...run, outcome, deleteStores: deps.deleteStores }
	}

	it("deletes them before ready on the launch after the wipe, then records it, once", async () => {
		const first = await launch(WIPED)

		expect(first.outcome).toEqual({ result: "deleted" })
		expect(first.deleteStores).toHaveBeenCalledTimes(1)
		expect(first.stored()).toMatchObject({ wiped: true, purged: true })
		expect(first.deps.info).toHaveBeenCalledWith("migration: the old client's stores were deleted from disk")

		const second = await launch(first.stored())

		expect(second.outcome).toEqual({ result: "not-due" })
		expect(second.deleteStores).not.toHaveBeenCalled()
		expect(second.markerFile.text()).toBe(first.markerFile.text())
	})

	it("never deletes them before the secrets were wiped, nor without a readable marker", async () => {
		for (const stored of [null, marker({ stage: "verified", wiped: false }), marker({ stage: "imported" })]) {
			const run = await launch(stored)

			expect(run.deleteStores).not.toHaveBeenCalled()
		}

		const unreadable = purgeDeps(null, {
			readMarker: () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" })
			}
		})

		expect(purgeBeforeReady(unreadable)).toEqual({ result: "not-due" })
		expect(purgeBeforeReady(purgeDeps("{not json"))).toEqual({ result: "not-due" })
		expect(unreadable.deleteStores).not.toHaveBeenCalled()
	})

	it("waits for a launch with the vault file present, so a sign-out cut short keeps the page's flag", async () => {
		const run = await launch(WIPED, { sessionStored: () => false })

		expect(run.outcome).toEqual({ result: "not-due" })
		expect(run.deleteStores).not.toHaveBeenCalled()
		expect(run.stored()).toMatchObject({ purged: false })
		expect(run.deps.info).toHaveBeenCalledWith("migration: deleting the old stores waits for a launch with a stored session")
	})

	it("leaves the marker unpurged on a Windows-like EBUSY, logs the code once and deletes them on the next launch", async () => {
		const busy = await launch(WIPED, {
			deleteStores: vi.fn(() => {
				throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" })
			})
		})

		expect(busy.outcome).toEqual({ result: "failed", code: "EBUSY" })
		expect(busy.deps.warn).toHaveBeenCalledTimes(1)
		expect(busy.deps.warn).toHaveBeenCalledWith("migration: deleting the old stores failed, tried again next launch: EBUSY")
		expect(busy.stored()).toMatchObject({ wiped: true, purged: false })

		const next = await launch(busy.stored())

		expect(next.deleteStores).toHaveBeenCalledTimes(1)
		expect(next.stored()).toMatchObject({ purged: true })
	})

	it("does not record the purge when the marker cannot be written, so the next launch deletes them again", async () => {
		const deps = purgeDeps(serializeMarker(WIPED))
		const run = setup({ marker: WIPED })

		run.deps.earlyPurge.mockReturnValue(purgeBeforeReady(deps))
		vi.spyOn(run.deps.marker, "write").mockRejectedValueOnce(Object.assign(new Error("full"), { code: "ENOSPC" }))
		await run.migration.start()

		expect(run.stored()).toMatchObject({ purged: false })
		expect(run.deps.info).not.toHaveBeenCalledWith("migration: the old client's stores were deleted from disk")
	})

	it("deletes the old origin's IndexedDB and the Local Storage store, keeping the other origins' IndexedDB", async () => {
		const userData = await mkdtemp(path.join(tmpdir(), "filen-purge-"))

		try {
			const oldDb = path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`)
			const oldBlobs = path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.blob`)
			const newDb = path.join(userData, "IndexedDB", "filen_app_0.indexeddb.leveldb")
			const localStorage = path.join(userData, "Local Storage", "leveldb")

			for (const dir of [oldDb, oldBlobs, newDb, localStorage]) {
				await mkdir(dir, { recursive: true })
				await writeFile(path.join(dir, "000003.log"), "value")
			}

			deleteLegacyStores(userData)

			expect([oldDb, oldBlobs, path.join(userData, "Local Storage")].filter(dir => existsSync(dir))).toEqual([])
			expect(existsSync(path.join(newDb, "000003.log"))).toBe(true)

			// Nothing left to delete, and no IndexedDB directory at all: still done.
			await rm(path.join(userData, "IndexedDB"), { recursive: true })
			expect(() => {
				deleteLegacyStores(userData)
			}).not.toThrow()
		} finally {
			await rm(userData, { recursive: true, force: true })
		}
	})
})

function oldPair(uuid: string, localPath: string) {
	return {
		name: localPath,
		uuid,
		localPath,
		remoteParentUUID: uuid,
		mode: "twoWay",
		excludeDotFiles: true,
		paused: false,
		localTrashDisabled: true
	}
}

const OLD_SYNC = {
	enabled: true,
	syncPairs: [
		oldPair("11111111-2222-4333-8444-555555555555", "/nonexistent/a"),
		oldPair("22222222-3333-4444-8555-666666666666", "/nonexistent/b")
	]
}

function legacySetup(options: { pairs?: Parameters<typeof memoryStore>[0]; legacyApplied?: boolean } = {}) {
	const store = memoryStore(options.pairs, options.legacyApplied)
	const native = fakeNative(store)
	const stash = {
		left: true as boolean,
		pending: vi.fn(() => Promise.resolve(stash.left ? OLD_SYNC : undefined)),
		consume: vi.fn(() => {
			stash.left = false

			return Promise.resolve()
		})
	}
	const ignorers = new Map<string, string>()
	const deps: LegacySyncDeps = { ...native.deps, legacyIgnorer: uuid => Promise.resolve(ignorers.get(uuid) ?? null), stash }

	return { store, native, stash, deps, ignorers }
}

describe("applyLegacySync", () => {
	it("stash consumed only after every pair is recorded", async () => {
		const { store, stash, deps, native } = legacySetup()

		stash.consume.mockImplementation(() => {
			expect(store.get()).toMatchObject({
				legacyApplied: true,
				pairs: [{ localRoot: "/nonexistent/a" }, { localRoot: "/nonexistent/b" }]
			})
			stash.left = false

			return Promise.resolve()
		})

		await applyLegacySync(deps)

		expect(stash.consume).toHaveBeenCalledOnce()
		expect(native.ops()).toEqual(["userIgnore", "setUserIgnore"])
		expect(native.argsOf("setUserIgnore")).toEqual([{ text: `${LEGACY_BUILTIN_RULES.join("\n")}\n` }])
	})

	it("carries each pair's old ignore file and dot-file switch into its rules, and notes what it could not carry", async () => {
		const { store, stash, deps, ignorers } = legacySetup()

		ignorers.set("11111111-2222-4333-8444-555555555555", "*.bak\n")
		const first = oldPair("11111111-2222-4333-8444-555555555555", "/nonexistent/a")

		// One that is no pair, and one listed twice.
		stash.pending.mockResolvedValue({ ...OLD_SYNC, syncPairs: [...OLD_SYNC.syncPairs, { ...first, uuid: "x" }, first] })
		await applyLegacySync(deps)

		expect(store.get().pairs.map(pair => pair.legacyRules)).toEqual([
			["*.bak", ".*", "!/.filenignore"],
			[".*", "!/.filenignore"]
		])
		expect(store.get().importNote).toEqual({ dropped: 1, merged: 1 })
	})

	it("tells the pairs that had the old local trash off about their bin", async () => {
		const { store, stash, deps } = legacySetup()

		stash.pending.mockResolvedValue({
			...OLD_SYNC,
			syncPairs: [
				{ ...oldPair("11111111-2222-4333-8444-555555555555", "/nonexistent/a"), localTrashDisabled: false },
				oldPair("22222222-3333-4444-8555-666666666666", "/nonexistent/b")
			]
		})
		await applyLegacySync(deps)

		expect(store.get().pairs.map(pair => [pair.notices, pair.info])).toEqual([
			[[], []],
			[[], ["localTrashNowOn"]]
		])
		expect(store.get().importNote).toBeNull()
	})

	it("keeps the stash and records nothing while the device-wide ignore cannot be set", async () => {
		const { store, stash, deps } = legacySetup()
		const failing = fakeNative(store, { setUserIgnore: () => new Refusal("hostUnavailable") })

		await expect(applyLegacySync({ ...deps, call: failing.deps.call })).rejects.toThrow()
		expect(store.get()).toMatchObject({ legacyApplied: false, pairs: [] })
		expect(stash.consume).not.toHaveBeenCalled()
	})

	it("rerun after a crash adds no duplicates", async () => {
		// A crash before the stash was consumed: the run starts over.
		const crashed = legacySetup()

		crashed.stash.consume.mockRejectedValueOnce(new Error("crash"))
		await applyLegacySync(crashed.deps)
		expect(crashed.stash.left).toBe(true)

		await applyLegacySync(crashed.deps)
		expect(crashed.store.get().pairs).toHaveLength(2)
		expect(crashed.stash.left).toBe(false)
		// The ignore was written once; a rerun past it only consumes.
		expect(crashed.native.argsOf("setUserIgnore")).toHaveLength(1)

		// A crash between recording some pairs and the flag: only the missing one is recorded.
		const partial = legacySetup({ pairs: crashed.store.get().pairs.slice(0, 1) })

		await applyLegacySync(partial.deps)
		expect(partial.store.get().pairs.map(pair => pair.localRoot)).toEqual(["/nonexistent/a", "/nonexistent/b"])
	})

	it("does nothing without a waiting stash", async () => {
		const { stash, deps, native } = legacySetup()

		stash.left = false
		await applyLegacySync(deps)
		expect(native.ops()).toEqual([])
	})
})

function fakeCipher(): VaultCipher {
	return {
		encrypt: plain => Promise.resolve(Buffer.from(`enc:${plain}`)),
		decrypt: data => Promise.resolve({ result: data.toString().slice(4), shouldReEncrypt: false })
	}
}

const STASH: LegacyStash = {
	version: 1,
	userId: 1001,
	users: { sync: { "1002": { enabled: true, syncPairs: [] } }, networkDrive: { "1001": { enabled: false } }, webdav: {}, s3: {} },
	fallback: { sync: OLD_SYNC }
}

describe("stash store", () => {
	it("says whether the stash was stored, keeping it for this run without secure storage", async () => {
		const stored = memoryFile()
		const kept = memoryFile()

		await expect(createStashStore(stored, () => Promise.resolve(fakeCipher()), vi.fn()).write(JSON.stringify(STASH))).resolves.toBe(
			true
		)

		const volatile = createStashStore(kept, () => Promise.resolve(null), vi.fn())

		await expect(volatile.write(JSON.stringify(STASH))).resolves.toBe(false)
		expect(kept.text()).toBeNull()
		expect(await volatile.pending("1001", "sync")).toEqual(OLD_SYNC)
	})

	it("consumes one user's part of a feature and deletes the stash once empty", async () => {
		const file = memoryFile(`enc:${JSON.stringify(STASH)}`)
		const store = createStashStore(file, () => Promise.resolve(fakeCipher()), vi.fn())

		expect(await store.pending("1001", "sync")).toEqual(OLD_SYNC)
		expect(await store.pending("1003", "sync")).toBeUndefined()

		await store.consume("1001", "sync")
		expect(await store.pending("1001", "sync")).toBeUndefined()
		expect(file.text()?.startsWith("enc:")).toBe(true)
		expect(JSON.parse(file.text()?.slice(4) ?? "")).toEqual({ ...STASH, fallback: {} })

		await store.consume("1002", "sync")
		await store.consume("1001", "networkDrive")
		expect(file.text()).toBeNull()
	})

	it("reads a stash it cannot decrypt again later, never removing it", async () => {
		const file = memoryFile(`enc:${JSON.stringify(STASH)}`)
		let locked = true
		const cipher: VaultCipher = {
			...fakeCipher(),
			decrypt: data => (locked ? Promise.reject(new Error("locked")) : fakeCipher().decrypt(data))
		}
		const store = createStashStore(file, () => Promise.resolve(cipher), vi.fn())

		expect(await store.pending("1001", "sync")).toBeUndefined()
		locked = false
		expect(await store.pending("1001", "sync")).toEqual(OLD_SYNC)
	})

	it("withoutFeature keeps other users' and other features' parts", () => {
		expect(withoutFeature(STASH, "1002", "sync")).toEqual({ ...STASH, users: { ...STASH.users, sync: {} } })
	})
})

describe("the old client's logs directory", () => {
	it("is beside userData, and deleting it keeps userData and its retired sync state", async () => {
		const appData = await realpath(await mkdtemp(path.join(tmpdir(), "filen-legacy-logs-")))

		try {
			const userData = path.join(appData, "@filen", "desktop")
			const logs = legacyLogsDir(userData)
			const retired = path.join(userData, "sync.migrated-2026-10-01")

			expect(logs).toBe(path.join(appData, "@filen", "logs"))

			await mkdir(logs, { recursive: true })
			await mkdir(retired, { recursive: true })

			for (const name of ["desktop.log", "desktop-worker.log", "rclone-1.log", "sync.log"]) {
				await writeFile(path.join(logs, name), "line\n")
			}

			await writeFile(path.join(retired, "state.json"), "{}")
			await removeTree(logs)
			await removeTree(logs)

			expect(existsSync(logs)).toBe(false)
			expect(existsSync(path.join(retired, "state.json"))).toBe(true)
		} finally {
			await rm(appData, { recursive: true, force: true })
		}
	})
})
