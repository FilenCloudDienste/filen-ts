import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"
import type { DesktopSyncOverview } from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { afterEach, describe, expect, it } from "vitest"
import {
	BARE_PAIR,
	bareImported,
	fallbackImported,
	findingsFor,
	legacyNetworkDriveGone,
	leftoversBeside,
	OLDER_SDK_CONFIG_SHAPE,
	OLDER_SKIPPED,
	OTHER_ACCOUNT_PAIR,
	plantedHeld,
	plantedShape,
	sdkConfigShapeOf
} from "../../scripts/ci/e2e/chains/older.ts"
import { createFindings } from "../../scripts/ci/e2e/findings.ts"
import { LEGACY_PAIRS } from "../../scripts/ci/e2e/fixtures.ts"
import { configureLegacy, type LegacySyncPair } from "../../scripts/ci/e2e/legacyApp.ts"
import { hookReady, hookScript, type HookState } from "../../scripts/ci/e2e/legacyHook.ts"
import { installedBy, legacyLinkProblems, promptShim, updateEnvFor } from "../../scripts/ci/e2e/olderUpdate.ts"
import { describeStored, LEGACY_SDK_CONFIG_SHAPE, legacySeed } from "../../scripts/ci/e2e/seed.ts"
import { authVersionCheck, LEGACY_PIN, LEGACY_SHA512, OLDER_PIN, pinFor } from "../../scripts/ci/legacy.ts"
import { MAX_LOGINS_PER_RUN, plan, type PlanInput } from "../../scripts/ci/e2ePlan.ts"
import { OLDER_DEEP_ENTRIES, OLDER_INSTALL_ENTRIES, weekday } from "../../scripts/ci/olderPlan.ts"
import type { Target } from "../../scripts/ci/targets.ts"
import { LEGACY_KEYS, legacySession } from "../main/legacyData.ts"

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-older-"))

	dirs.push(dir)

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

const release: PlanInput = {
	platforms: "windows,mac,linux",
	profile: "release",
	eventName: "workflow_call",
	signed: true,
	scenarios: "previous,legacy",
	legacy: true,
	formats: "",
	depth: "",
	spike: "none",
	signin: "",
	day: 0
}

const idOf = (entry: { platform: string; arch: string; format: string }) => `${entry.platform}-${entry.arch}-${entry.format}`

describe("3.0.47 pin", () => {
	it("pins every installer 3.0.53's table has, by the same names, from the 3.0.47 release", () => {
		expect(Object.keys(OLDER_PIN.sha512).sort()).toEqual(Object.keys(LEGACY_SHA512).sort())
		expect(OLDER_PIN.releaseUrl).toBe("https://github.com/FilenCloudDienste/filen-desktop/releases/download/v3.0.47/")
		expect(Object.values(OLDER_PIN.sha512).every(hash => /^[A-Za-z0-9+/]{86}==$/.test(hash))).toBe(true)
		expect(OLDER_PIN).toMatchObject({ version: "3.0.47", released: "2025-02-09", hasE2eHook: false })
		expect(OLDER_PIN.linuxExecutable).toBe("/opt/Filen/@filendesktop")
		expect(pinFor("older")).toBe(OLDER_PIN)
		expect(pinFor("legacy")).toBe(LEGACY_PIN)
		expect(pinFor("previous")).toBeNull()
		expect(pinFor("toString")).toBeNull()
	})

	it("drops only 3.0.47's chain for an account whose auth version it cannot sign in to, failing nothing", () => {
		expect(authVersionCheck(2, "3.0.53,3.0.47")).toEqual({ dropOlder: null, problem: null })
		expect(authVersionCheck(3, "3.0.53")).toEqual({ dropOlder: null, problem: null })
		expect(authVersionCheck(3, "")).toEqual({ dropOlder: null, problem: null })

		const check = authVersionCheck(3, "3.0.53,3.0.47")

		expect(check.problem).toBeNull()
		expect(check.dropOlder).toMatch(/auth v3, which 3\.0\.47 \(v1, v2 only\) cannot sign in to: its signed-in chain is dropped/)
		expect(check.dropOlder).toMatch(/install-only update runs instead/)
		expect(authVersionCheck(4, "3.0.53,3.0.47")).toMatchObject({
			dropOlder: expect.stringMatching(/3\.0\.47/) as unknown,
			problem: expect.stringMatching(/auth v4, which 3\.0\.53 \(v1, v2, v3 only\) cannot sign in to/) as unknown
		})
	})
})

describe("3.0.47 in the plan", () => {
	it("runs deep from 3.0.47 at release on Windows, macOS and the Linux deb, one of them signed in for real", () => {
		const result = plan(release)
		const older = result.tests.filter(entry => entry.older)

		expect(older.map(idOf)).toEqual([...OLDER_DEEP_ENTRIES])
		expect(older.every(entry => entry.deepOlder && entry.deep)).toBe(true)
		expect(older.map(entry => entry.signInOlder)).toEqual(["real", "seeded", "seeded"])
		expect(result.tests.filter(entry => !entry.older).every(entry => !entry.deepOlder && entry.signInOlder === "")).toBe(true)
		// Two session slots, one 4.x and one 3.0.53 form per OS, one 3.0.47 form, the quota account's form.
		expect(result.logins).toBe(10)
		expect(result.logins).toBeLessThanOrEqual(MAX_LOGINS_PER_RUN)
		expect(result.pins).toBe("3.0.53,3.0.47")
		// The real 3.0.47 sign-in is spaced like the others.
		const staggers = result.tests.filter(entry => entry.stagger > 0 || entry.signInOlder === "real").map(entry => entry.stagger)

		expect(new Set(staggers).size).toBe(staggers.length)
	})

	it("runs at install depth from 3.0.47 at a release asked for install depth, on Windows and the Linux deb", () => {
		const result = plan({ ...release, depth: "install" })

		expect(result.tests.filter(entry => entry.older).map(idOf)).toEqual([...OLDER_INSTALL_ENTRIES])
		expect(result.tests.some(entry => entry.deepOlder)).toBe(false)
		expect(result.pins).toBe("")
	})

	it("adds the install-depth update from 3.0.47 on Wednesday nights only", () => {
		const night = { ...release, profile: "", eventName: "schedule", scenarios: "", signed: false }
		// 1970-01-07 was a Wednesday.
		const wednesday = 6

		expect(weekday(wednesday)).toBe(3)

		const on = plan({ ...night, day: wednesday + 7 * 2900 })

		expect(on.tests.filter(entry => entry.older).map(idOf)).toEqual([...OLDER_INSTALL_ENTRIES])
		expect(on.tests.some(entry => entry.deepOlder)).toBe(false)
		expect(on.logins).toBe(plan({ ...night, day: wednesday + 1 }).logins)

		for (const day of [0, 1, 2, 3, 4, 5]) {
			expect(plan({ ...night, day }).tests.some(entry => entry.older)).toBe(false)
		}
	})

	it("runs from 3.0.47 by hand only when SCENARIOS names it, and never without legacy", () => {
		const dispatch: PlanInput = { ...release, profile: "custom", eventName: "workflow_dispatch" }

		expect(plan(dispatch).tests.some(entry => entry.older)).toBe(false)

		const only = plan({ ...dispatch, scenarios: "older" })

		expect(only.tests.filter(entry => entry.older).map(idOf)).toEqual([...OLDER_DEEP_ENTRIES])
		expect(only.tests.every(entry => !entry.previous && !entry.legacy && !entry.deepPrevious && !entry.deepLegacy)).toBe(true)
		expect(only.logins).toBe(3)
		expect(only.pins).toBe("3.0.47")
		expect(plan({ ...dispatch, scenarios: "older", depth: "install" }).tests.map(idOf)).toEqual([...OLDER_INSTALL_ENTRIES])
		expect(plan({ ...dispatch, scenarios: "older", signin: "real" }).logins).toBe(5)
		expect(() => plan({ ...dispatch, scenarios: "older", legacy: false })).toThrow(/nothing to test/)
		expect(plan({ ...release, legacy: false }).tests.some(entry => entry.older)).toBe(false)
		expect(() => plan({ ...dispatch, scenarios: "previous,older,newer" })).toThrow(/SCENARIOS/)
	})
})

describe("3.0.47 update launch hook", () => {
	// The module loader as the old main process has it, and the modules the hook looks for.
	const loaded = (holdSync: boolean, feed: string | null) => {
		const feeds: unknown[] = []
		const autoUpdater = Object.assign(new EventEmitter(), {
			feeds,
			setFeedURL: (options: unknown) => feeds.push(options)
		})
		const installs: string[] = []
		class Updater {
			initialized = 0
			initialize() {
				this.initialized++
				autoUpdater.on("update-downloaded", () => installs.push("app listener"))
			}
			installUpdate() {
				installs.push("installUpdate")

				return Promise.resolve()
			}
		}
		class Worker {
			invoke(channel: string) {
				return Promise.resolve(`ran ${channel}`)
			}
		}
		const modules: Record<string, unknown> = {
			"electron-updater": { autoUpdater },
			"./lib/updater": { Updater, default: Updater },
			"./worker": { Worker }
		}
		const Module = { _load: (request: string) => modules[request] }
		const timers: (() => void)[] = []
		const context = {
			process: { getBuiltinModule: () => Module },
			setTimeout: (run: () => void) => timers.push(run),
			Promise
		} as { process: unknown; setTimeout: unknown; Promise: unknown; __e2eHook?: HookState }

		expect(runInNewContext(hookScript({ holdSync, feed }), context)).toBe("hooked")

		return { Module, autoUpdater, installs, timers, context }
	}

	it("points electron-updater at the feed when it loads and installs what it downloads through the app's own installUpdate, once", async () => {
		const { Module, autoUpdater, installs, timers, context } = loaded(false, "http://127.0.0.1:4567/")
		const updater = Module._load("./lib/updater") as { Updater: new () => { initialize(): void } }

		expect(hookReady(context.__e2eHook ?? null, { holdSync: false, feed: "x" })).toBe(false)
		Module._load("electron-updater")
		expect(autoUpdater.feeds).toEqual([{ provider: "generic", url: "http://127.0.0.1:4567/" }])
		expect(hookReady(context.__e2eHook ?? null, { holdSync: false, feed: "x" })).toBe(true)

		new updater.Updater().initialize()
		autoUpdater.emit("update-downloaded", {})
		autoUpdater.emit("update-downloaded", {})

		for (const run of timers.splice(0)) {
			run()
		}

		await Promise.resolve()
		// The app's own listener first, then exactly one install.
		expect(installs).toEqual(["app listener", "app listener", "installUpdate"])
		expect(context.__e2eHook?.installs).toBe(1)
	})

	it("holds sync without touching the updater when the client has its own E2E hook", async () => {
		const { Module, autoUpdater, context } = loaded(true, null)
		const worker = new (Module._load("./worker") as { Worker: new () => { invoke(channel: string): Promise<unknown> } }).Worker()

		Module._load("electron-updater")
		Module._load("./lib/updater")
		expect(autoUpdater.feeds).toEqual([])
		expect(await worker.invoke("restartSync")).toBeUndefined()
		expect(await worker.invoke("restartHTTP")).toBe("ran restartHTTP")
		expect(context.__e2eHook).toMatchObject({ held: true, dropped: ["restartSync"], feed: false, updater: false })
		expect(hookReady(context.__e2eHook ?? null, { holdSync: true, feed: null })).toBe(true)
	})
})

describe("3.0.47 on Linux", () => {
	const deb = {
		platform: "linux",
		format: "deb",
		executable: "/opt/Filen/Filen",
		registeredVersion: () => "3.0.47",
		mainProcesses: () => []
	} as unknown as Target

	it("installs and runs as /opt/Filen/@filendesktop on the deb, as 4.x's target elsewhere", () => {
		expect(installedBy(deb, OLDER_PIN).executable).toBe("/opt/Filen/@filendesktop")
		expect(installedBy(deb, LEGACY_PIN)).toBe(deb)
		const win = { ...deb, platform: "win" } as Target

		expect(installedBy(win, OLDER_PIN)).toBe(win)
		expect(installedBy({ ...deb, format: "AppImage" } as Target, OLDER_PIN).executable).toBe("/opt/Filen/Filen")
	})

	it.skipIf(process.platform === "win32")(
		"gives the old updater a pkexec that drops its polkit flag and runs the rest through sudo, on its PATH only",
		() => {
			const dir = tempDir()
			const bin = path.join(dir, "bin")

			mkdirSync(bin)
			// A sudo that prints what it was asked to run.
			writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\nprintf "%s|" "$@"\n')
			chmodSync(path.join(bin, "sudo"), 0o755)

			const shim = promptShim(path.join(dir, "shim"))
			const ran = spawnSync(
				path.join(shim, "pkexec"),
				["--disable-internal-agent", "/bin/bash", "-c", "dpkg -i a.deb || apt-get install -f -y"],
				{
					encoding: "utf8",
					env: { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` }
				}
			)

			expect(ran.stdout).toBe("-n|/bin/bash|-c|dpkg -i a.deb || apt-get install -f -y|")

			const env = updateEnvFor(deb, OLDER_PIN, { PATH: "/usr/bin" }, dir)

			expect(env["PATH"]).toBe(`${path.join(dir, "prompt-shim")}${path.delimiter}/usr/bin`)
			expect(updateEnvFor(deb, LEGACY_PIN, { PATH: "/usr/bin" }, dir)["PATH"]).toBe("/usr/bin")
			expect(updateEnvFor({ ...deb, format: "AppImage" } as Target, OLDER_PIN, { PATH: "/usr/bin" }, dir)["PATH"]).toBe("/usr/bin")
		}
	)

	it.skipIf(process.platform === "win32")(
		"finds the old executable's link and the alternative its postinst registered resolving to N's executable, and names a dangling one",
		() => {
			const root = tempDir()
			const at = (...parts: string[]) => path.join(root, ...parts)

			mkdirSync(at("opt", "Filen"), { recursive: true })
			mkdirSync(at("usr", "bin"), { recursive: true })
			mkdirSync(at("etc", "alternatives"), { recursive: true })
			writeFileSync(at("opt", "Filen", "Filen"), "")

			expect(legacyLinkProblems("/opt/Filen/@filendesktop", "/opt/Filen/Filen", root).problems).toEqual([
				"/opt/Filen/@filendesktop is missing"
			])

			// What dpkg leaves after the update: 4.x's link, and 3.0.47's alternative its postrm failed to remove.
			symlinkSync("Filen", at("opt", "Filen", "@filendesktop"))
			symlinkSync(at("opt", "Filen", "@filendesktop"), at("etc", "alternatives", "@filendesktop"))
			symlinkSync(at("etc", "alternatives", "@filendesktop"), at("usr", "bin", "@filendesktop"))

			const linked = legacyLinkProblems("/opt/Filen/@filendesktop", "/opt/Filen/Filen", root)

			expect(linked.problems).toEqual([])
			expect(linked.seen).toHaveLength(3)

			// Without 4.x's link the alternative dangles.
			rmSync(at("opt", "Filen", "@filendesktop"))
			symlinkSync("gone", at("opt", "Filen", "@filendesktop"))
			expect(legacyLinkProblems("/opt/Filen/@filendesktop", "/opt/Filen/Filen", root).problems).toEqual([
				"/opt/Filen/@filendesktop dangles",
				"/usr/bin/@filendesktop dangles",
				"/etc/alternatives/@filendesktop dangles"
			])
		}
	)
})

describe("3.0.47 sign-in seed", () => {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const client = {
		email: "e2e@example.invalid",
		userId: 123n,
		rootUuid: "00000000-0000-0000-0000-000000000001",
		authInfo: "key-one|key-two",
		privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
		apiKey: "a".repeat(64),
		authVersion: 2
	}
	// What 3.0.47's signed-out start stores (filen-web 0.1.87 setup() for a fresh install): its DEFAULT_SDK_CONFIG,
	// without the tmpPath 0.4.2's anonymous config has.
	const anonymousSdk = {
		email: "anonymous",
		password: "anonymous",
		masterKeys: ["anonymous"],
		connectToSocket: true,
		metadataCache: true,
		twoFactorCode: "anonymous",
		publicKey: "anonymous",
		privateKey: "anonymous",
		apiKey: "anonymous",
		authVersion: 2,
		baseFolderUUID: "anonymous",
		userId: 1
	}

	it("builds what its login stores, in the shape its real sign-in is checked against, which 4.x migrates", () => {
		const seed = legacySeed(client, { sdkConfig: anonymousSdk, desktopConfig: { sdkConfig: anonymousSdk } })

		expect(describeStored(seed.sdkConfig, client.apiKey)).toEqual({ shape: [...OLDER_SDK_CONFIG_SHAPE], sameKey: true })
		expect(OLDER_SDK_CONFIG_SHAPE).toEqual(LEGACY_SDK_CONFIG_SHAPE.slice(0, -1))
		expect(sdkConfigShapeOf(OLDER_PIN)).toBe(OLDER_SDK_CONFIG_SHAPE)
		expect(sdkConfigShapeOf(LEGACY_PIN)).toBe(LEGACY_SDK_CONFIG_SHAPE)

		const migrated = legacySession({
			[LEGACY_KEYS.authed]: "true",
			[LEGACY_KEYS.sdkConfig]: seed.sdkConfig,
			[LEGACY_KEYS.desktopConfig]: seed.desktopConfig
		})

		expect(migrated.ok).toBe(true)
	})
})

describe("older shapes planted in chain L", () => {
	const pairs: LegacySyncPair[] = LEGACY_PAIRS.map(pair => ({
		uuid: `uuid-${pair.name}`,
		name: pair.name,
		localPath: `/home/e2e/${pair.name}`,
		remotePath: `/e2e/${pair.name}`,
		remoteParentUUID: `dir-${pair.name}`,
		mode: pair.legacyMode,
		excludeDotFiles: pair.excludeDotFiles,
		paused: false,
		localTrashDisabled: pair.localTrashDisabled
	}))

	// configureLegacy's page script against a localStorage as 3.0.53 holds it once signed in.
	const configured = async (shape: ReturnType<typeof plantedShape> | undefined) => {
		const store = new Map<string, string>([
			[
				LEGACY_KEYS.desktopConfig,
				JSON.stringify({
					syncConfig: { enabled: true, syncPairs: [], dbPath: "" },
					networkDriveConfig: {},
					webdavConfig: {},
					s3Config: {}
				})
			],
			[LEGACY_KEYS.sdkConfig, JSON.stringify({ userId: 123 })],
			[LEGACY_KEYS.sync, JSON.stringify({ 77: { enabled: true, syncPairs: [] } })]
		])
		const events: string[] = []
		const page = {
			evaluate: (script: string) =>
				Promise.resolve(
					runInNewContext(script, {
						localStorage: {
							getItem: (key: string) => store.get(key) ?? null,
							setItem: (key: string, value: string) => store.set(key, value)
						},
						window: { dispatchEvent: (event: { key: string }) => events.push(event.key) },
						StorageEvent: class {
							key: string
							constructor(_type: string, init: { key: string }) {
								this.key = init.key
							}
						},
						JSON,
						Object,
						Error
					}) as unknown
				)
		} as unknown as Page

		await configureLegacy(page, {
			pairs,
			drive: { mountPoint: "/home/e2e/mnt" },
			webdav: { username: "u", password: "p", port: 1 },
			pin: "123456",
			lockTimeout: 3600,
			...(shape === undefined ? {} : { oldShape: shape })
		})

		const read = (key: string) => JSON.parse(store.get(key) ?? "null") as Record<string, { syncPairs?: Record<string, unknown>[] }>

		return { read, events }
	}

	it("plants the bare pair, the sync config in desktopConfig only, and another account's pair in the map", async () => {
		const bare = LEGACY_PAIRS.find(pair => pair.name === BARE_PAIR)

		expect(bare && !bare.excludeDotFiles && !bare.localTrashDisabled).toBe(true)

		const shape = plantedShape(pairs, 123n, "/home/e2e", "e2e/run")
		const { read, events } = await configured(shape)
		const stored = read(LEGACY_KEYS.desktopConfig)["syncConfig"]?.syncPairs ?? []
		const sync = read(LEGACY_KEYS.sync)

		expect(stored.map(pair => pair["name"])).toEqual(LEGACY_PAIRS.map(pair => pair.name))
		expect(stored.filter(pair => !("excludeDotFiles" in pair) && !("localTrashDisabled" in pair)).map(pair => pair["name"])).toEqual([
			BARE_PAIR
		])
		// The account has no entry; the one already there and the planted other account's stay.
		expect(Object.keys(sync).sort()).toEqual(["124", "77"])
		expect(sync["124"]?.syncPairs?.map(pair => pair["name"])).toEqual([OTHER_ACCOUNT_PAIR])
		expect(Object.keys(read(LEGACY_KEYS.networkDrive))).toEqual(["123"])
		expect(events).toContain(LEGACY_KEYS.sync)

		const plain = await configured(undefined)

		expect(Object.keys(plain.read(LEGACY_KEYS.sync)).sort()).toEqual(["123", "77"])
		expect(plain.read(LEGACY_KEYS.desktopConfig)["syncConfig"]?.syncPairs?.every(pair => "excludeDotFiles" in pair)).toBe(true)
	})

	it("holds the old app to the planted shapes until it quits", async () => {
		const shape = plantedShape(pairs, 123n, "/home/e2e", "e2e/run")
		const { read } = await configured(shape)
		const bareUuid = `uuid-${BARE_PAIR}`
		const planted = { sync: read(LEGACY_KEYS.sync), syncConfig: read(LEGACY_KEYS.desktopConfig)["syncConfig"] ?? null }

		expect(plantedHeld(planted, 123n, bareUuid)).toMatch(/without both switches/)

		// The web wrote the account's entry back: N would read the normal per-user shape.
		expect(() => plantedHeld({ ...planted, sync: { ...planted.sync, 123: { syncPairs: [] } } }, 123n, bareUuid)).toThrow(/has an entry/)
		// Or dropped the other account's entry.
		expect(() => plantedHeld({ ...planted, sync: { 77: {} } }, 123n, bareUuid)).toThrow(/other account/)

		// Or wrote the switches back into the bare pair.
		const filled = {
			syncPairs: pairs.map(pair => (pair.uuid === bareUuid ? { ...pair, excludeDotFiles: false } : pair))
		}

		expect(() => plantedHeld({ ...planted, syncConfig: filled }, 123n, bareUuid)).toThrow(/has excludeDotFiles/)
		expect(() => plantedHeld({ sync: null, syncConfig: null }, 123n, bareUuid)).toThrow()

		// Without the planted shape there is nothing to hold.
		const plain = await configured(undefined)

		expect(() =>
			plantedHeld(
				{ sync: plain.read(LEGACY_KEYS.sync), syncConfig: plain.read(LEGACY_KEYS.desktopConfig)["syncConfig"] ?? null },
				123n,
				bareUuid
			)
		).toThrow()
	})

	it("holds N to the fallback's pairs only and the bare pair to both switches off", () => {
		const dir = tempDir()
		const overview = (names: string[], info: string[] = []) =>
			({ pairs: names.map(name => ({ name, info })) }) as unknown as DesktopSyncOverview
		const names = LEGACY_PAIRS.map(pair => pair.name)

		mkdirSync(path.join(dir, BARE_PAIR))
		expect(fallbackImported(overview(names), dir)).toMatch(/other account's pair neither imported nor created/)
		expect(() => fallbackImported(overview([...names, OTHER_ACCOUNT_PAIR]), dir)).toThrow()
		expect(() => fallbackImported(overview(names.slice(1)), dir)).toThrow()
		expect(bareImported(overview(names), path.join(dir, BARE_PAIR))).toMatch(/both|off/)
		expect(() => bareImported(overview(names, ["localTrashNowOn"]), path.join(dir, BARE_PAIR))).toThrow()
		writeFileSync(path.join(dir, BARE_PAIR, ".filenignore"), ".*\n")
		expect(() => bareImported(overview(names), path.join(dir, BARE_PAIR))).toThrow()
	})
})

describe("chain L from 3.0.47", () => {
	it("records the checks that test N alone as not run, and files its evidence under its own name", async () => {
		const artifacts = tempDir()
		const inner = createFindings("older", artifacts)
		const findings = findingsFor(inner, OLDER_PIN, "older")
		const ran: string[] = []

		for (const name of [
			"L10 only the edits",
			"L11 the held conflict resolved",
			"L12 the bins",
			"L14 a live edit uploads",
			"L15 sign out"
		]) {
			await findings.check(name, () => {
				ran.push(name)

				return "ran"
			})
		}

		await findings.must("N quits after the profile wipe", () => {
			ran.push("quit")

			return "ran"
		})
		findings.attach("legacy-sdk-config-shape.json", "[]")

		expect(ran).toEqual(["L10 only the edits", "L15 sign out"])
		expect(OLDER_SKIPPED.length).toBeGreaterThan(0)
		expect(findingsFor(inner, LEGACY_PIN, "legacy")).toBe(inner)
		expect(existsSync(path.join(artifacts, "older-sdk-config-shape.json"))).toBe(true)
		expect(existsSync(path.join(artifacts, "legacy-sdk-config-shape.json"))).toBe(false)
		inner.finish()
	})

	it("allows nothing beside userData after the uninstall, the old release's network drive included", () => {
		const appData = tempDir()
		const userData = path.join(appData, "desktop")

		mkdirSync(userData)
		expect(leftoversBeside(userData)).toBe("nothing beside desktop")
		expect(legacyNetworkDriveGone(userData)).toBe(`${path.join(appData, "network-drive")} gone`)
		mkdirSync(path.join(appData, "network-drive"))
		expect(() => leftoversBeside(userData)).toThrow(/network-drive/)
		expect(() => legacyNetworkDriveGone(userData)).toThrow(/network-drive is still there/)
		rmSync(path.join(appData, "network-drive"), { recursive: true })
		mkdirSync(path.join(appData, "logs"))
		expect(() => leftoversBeside(userData)).toThrow(/logs/)
		expect(leftoversBeside(path.join(tempDir(), "missing", "desktop"))).toBe("nothing beside desktop")
	})
})
