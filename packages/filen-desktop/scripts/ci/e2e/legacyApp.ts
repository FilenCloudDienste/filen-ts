import type { Page } from "playwright-core"
import { LEGACY_KEYS } from "../../../src/main/legacyData.ts"
import { fail, waitFor } from "../support.ts"
import type { LegacyMode } from "./fixtures.ts"
import { exitWithin, type Launched } from "./launch.ts"
import { inspector, legacyUpdateHook } from "./legacyHook.ts"

// The old client (3.0.53), driven from outside: its page over --remote-debugging-port, its main process over its Node
// inspector (it has no fuses). Its page keeps everything in localStorage under the keys 4.x imports (LEGACY_KEYS); the
// settings are written there exactly as its own web app's setters write them (JSON values, the account's per-user
// maps beside desktopConfig, a storage event per key), so its hooks re-read them and hand the config to main as a
// settings change does.

export const LEGACY_ORIGIN = "filendesktop://bundle"

// The old SyncPair (filen-sync types.ts); `remoteParentUUID` is the pair's remote directory itself.
export interface LegacySyncPair {
	uuid: string
	name: string
	localPath: string
	remotePath: string
	remoteParentUUID: string
	mode: LegacyMode
	excludeDotFiles: boolean
	paused: boolean
	localTrashDisabled: boolean
}

export interface LegacySettings {
	pairs: LegacySyncPair[]
	drive: { mountPoint: string }
	webdav: { username: string; password: string; port: number }
	pin: string
	// Seconds of inactivity before the old app locks; 4.x imports a PIN only with one.
	lockTimeout: number
	// Shapes older clients left (scripts/ci/e2e/chains/older.ts), planted among the rest.
	oldShape?: LegacyOldShape
}

// What clients before 3.0.39 stored: pairs without `excludeDotFiles` and `localTrashDisabled` (the old engine read
// both by truthiness), and a feature's config in desktopConfig only, with no entry for the account in its per-user map
// (which the old web then fell back to). `others` are other accounts' entries in those maps (userId digits -> config).
export interface LegacyOldShape {
	// Pair uuids stored without the two switches.
	bare: string[]
	// desktopConfig sections (syncConfig, ...) left out of the account's per-user maps.
	fallbackOnly: string[]
	others: Record<string, Record<string, unknown>>
}

// The real sign-in form (filen-web 0.2.3 login.tsx), one attempt. Done when the page stored the account; returns its
// userId and its API key (the latter only for the secret scan, masked by the caller).
export async function legacySignIn(
	page: Page,
	email: string,
	password: string,
	timeoutMs: number
): Promise<{ userId: number; apiKey: string }> {
	await page.locator("input#email").waitFor({ state: "visible", timeout: timeoutMs })
	await page.locator("input#email").fill(email)
	await page.locator("input#password").fill(password)
	await page.locator("button[type=submit]").click()

	// A probe during the page's own navigation may lose its context; it is asked again.
	return waitFor("the old app to store the account", timeoutMs, async () => {
		const read = (await page
			.evaluate(
				`(() => {
				if (localStorage.getItem(${JSON.stringify(LEGACY_KEYS.authed)}) !== "true") return null
				const config = JSON.parse(localStorage.getItem(${JSON.stringify(LEGACY_KEYS.sdkConfig)}) ?? "null")
				return config && config.userId > 1 && typeof config.apiKey === "string" ? { userId: config.userId, apiKey: config.apiKey } : null
			})()`
			)
			.catch(() => null)) as { userId: number; apiKey: string } | null

		return read
	})
}

// Counts the old engine's per-pair messages as main posts them to the page (cycleNoChanges: a pass found nothing to
// do), keyed by the pair's uuid, and every message type; keeps each pair's last non-empty error and ignore lists
// (localTreeErrors, taskErrors, localTreeIgnored, remoteTreeIgnored: paths and reasons) for the evidence.
export async function watchLegacySync(page: Page): Promise<void> {
	await page.evaluate(`(() => {
		if (globalThis.__e2eSync) return
		const state = (globalThis.__e2eSync = { quiet: {}, types: {}, details: {} })
		const kept = ["localTreeErrors", "taskErrors", "localTreeIgnored", "remoteTreeIgnored"]
		window.desktopAPI.onMainToWindowMessage(message => {
			if (!message || message.type !== "sync" || !message.message) return
			const type = String(message.message.type)
			state.types[type] = (state.types[type] ?? 0) + 1
			const uuid = message.message.syncPair && message.message.syncPair.uuid
			if (typeof uuid !== "string") return
			if (type === "cycleNoChanges") state.quiet[uuid] = (state.quiet[uuid] ?? 0) + 1
			const data = message.message.data
			const list = data && (data.errors ?? data.ignored)
			if (kept.includes(type) && Array.isArray(list) && list.length > 0) {
				state.details[uuid + " " + type] = JSON.stringify(list).slice(0, 4000)
			}
		})
	})()`)
}

export interface LegacySyncCounts {
	quiet: Record<string, number>
	types: Record<string, number>
	// "<pair uuid> <message type>" -> the last non-empty list, as JSON.
	details: Record<string, string>
}

export async function legacySyncCounts(page: Page): Promise<LegacySyncCounts> {
	return (await page.evaluate("globalThis.__e2eSync ?? { quiet: {}, types: {}, details: {} }")) as LegacySyncCounts
}

// What the old settings dialogs write: prefs (tray, start minimized), the PIN and its lock timeout, the network drive,
// WebDAV and the sync pairs, for the signed-in account (with `oldShape`, partly as an older client left them).
export async function configureLegacy(page: Page, settings: LegacySettings): Promise<string[]> {
	const keys = await page.evaluate(
		`((keys, input) => {
			const parse = (key, fallback) => {
				try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback } catch { return fallback }
			}
			const config = parse(keys.desktopConfig, null)
			const userId = parse(keys.sdkConfig, {}).userId
			if (config === null || !(userId > 1)) throw new Error("the old app holds no desktopConfig or account")
			const shape = input.oldShape ?? { bare: [], fallbackOnly: [], others: {} }
			const pairs = input.pairs.map(pair => {
				if (!shape.bare.includes(pair.uuid)) return pair
				const { excludeDotFiles, localTrashDisabled, ...rest } = pair
				return rest
			})
			const next = {
				...config,
				syncConfig: { ...config.syncConfig, enabled: true, syncPairs: pairs },
				networkDriveConfig: { ...config.networkDriveConfig, enabled: true, readOnly: false, mountPoint: input.drive.mountPoint },
				webdavConfig: {
					...config.webdavConfig,
					enabled: true,
					username: input.webdav.username,
					password: input.webdav.password,
					hostname: "127.0.0.1",
					port: input.webdav.port,
					https: false,
					proxyMode: false,
					authMode: "basic"
				}
			}
			const writes = {
				[keys.desktopConfig]: next,
				[keys.minimizeToTray]: true,
				[keys.startMinimized]: true,
				[keys.lockPin]: input.pin,
				[keys.lockTimeout]: input.lockTimeout
			}
			for (const [key, section] of [[keys.sync, "syncConfig"], [keys.networkDrive, "networkDriveConfig"], [keys.webdav, "webdavConfig"], [keys.s3, "s3Config"]]) {
				const users = parse(key, {})
				const kept = { ...(users !== null && typeof users === "object" && !Array.isArray(users) ? users : {}), ...(shape.others[section] ?? {}) }
				if (shape.fallbackOnly.includes(section)) delete kept[userId]
				writes[key] = shape.fallbackOnly.includes(section) ? kept : { ...kept, [userId]: next[section] }
			}
			for (const [key, value] of Object.entries(writes)) {
				const raw = JSON.stringify(value)
				localStorage.setItem(key, raw)
				window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw }))
			}
			return Object.keys(writes)
		})(${JSON.stringify(LEGACY_KEYS)}, ${JSON.stringify(settings)})`
	)

	return keys as string[]
}

// The two prefs as the old page holds them (its settings switches' values).
export async function legacyPrefs(page: Page): Promise<{ minimizeToTray: boolean; startMinimized: boolean }> {
	return (await page.evaluate(
		`({ minimizeToTray: localStorage.getItem(${JSON.stringify(LEGACY_KEYS.minimizeToTray)}) === "true", startMinimized: localStorage.getItem(${JSON.stringify(LEGACY_KEYS.startMinimized)}) === "true" })`
	)) as { minimizeToTray: boolean; startMinimized: boolean }
}

// The old app's own graceful quit (tray Quit, Cmd+Q): app.quit() runs before-quit and will-quit, which flushes and
// unmounts rclone. Scheduled, and the session closed first: Node holds a process at exit while a debugger is attached.
export async function quitLegacy(launched: Launched, timeoutMs: number): Promise<string> {
	const cdp = await inspector(launched.inspectPort ?? fail("the old app runs without its inspector"))

	try {
		await cdp.evaluate('setTimeout(() => process.mainModule.require("electron").app.quit(), 500), "scheduled"')
	} finally {
		cdp.close()
	}

	const exit = await exitWithin(launched, timeoutMs)

	if (exit === null) {
		fail(`the old app still runs ${String(timeoutMs / 1000)} s after app.quit()`)
	}

	return `exited with code ${String(exit.code)}, signal ${String(exit.signal)}`
}

// Holds the old app's sync during its update launch (scripts/ci/e2e/legacyHook.ts): its updater starts before its sync
// worker, but the download and the install race the first sync cycle, which would carry the closed-app edits before
// 4.x sees them. Before any of its code runs (--inspect-brk), a module-load hook wraps its worker's invoke so that sync
// starts and sync updates are dropped; the updater itself is untouched. With `feed` (a client without an E2E hook), the
// same hook points its updater at that loopback feed and installs what it downloads.
export interface SyncHold {
	args: string[]
	// Installs the hold, lets the app run and waits until its worker is wrapped; the dropped calls so far.
	started(): Promise<string[]>
}

export async function legacySyncHold(feed: string | null = null): Promise<SyncHold> {
	const hook = await legacyUpdateHook({ holdSync: true, feed })

	return { args: hook.args, started: async () => (await hook.started()).dropped }
}

// One more pair, as the old sync settings add one: appended to the account's sync config (desktopConfig and its
// per-user map), with the storage events its hooks re-read. Returns how many pairs the config holds now.
export async function addLegacyPair(page: Page, pair: LegacySyncPair): Promise<number> {
	const count = await page.evaluate(
		`((keys, pair) => {
			const parse = (key, fallback) => {
				try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback } catch { return fallback }
			}
			const config = parse(keys.desktopConfig, null)
			const userId = parse(keys.sdkConfig, {}).userId
			if (config === null || !(userId > 1)) throw new Error("the old app holds no desktopConfig or account")
			const syncConfig = { ...config.syncConfig, syncPairs: [...(config.syncConfig?.syncPairs ?? []), pair] }
			const users = parse(keys.sync, {})
			const writes = {
				[keys.desktopConfig]: { ...config, syncConfig },
				[keys.sync]: { ...(users !== null && typeof users === "object" && !Array.isArray(users) ? users : {}), [userId]: syncConfig }
			}
			for (const [key, value] of Object.entries(writes)) {
				const raw = JSON.stringify(value)
				localStorage.setItem(key, raw)
				window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw }))
			}
			return syncConfig.syncPairs.length
		})(${JSON.stringify(LEGACY_KEYS)}, ${JSON.stringify(pair)})`
	)

	return count as number
}
