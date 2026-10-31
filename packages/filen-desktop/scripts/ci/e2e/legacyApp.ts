import type { Page } from "playwright-core"
import { LEGACY_KEYS } from "../../../src/main/legacyData.ts"
import { fail, freePort, waitFor } from "../support.ts"
import { connectCdp, listTargets, type Cdp } from "./cdp/inspector.ts"
import type { LegacyMode } from "./fixtures.ts"
import { exitWithin, type Launched } from "./launch.ts"

// The old client (3.0.53), driven from outside: its page over --remote-debugging-port, its main process over its Node
// inspector (it has no fuses). Its page keeps everything in localStorage under the keys 4.x imports (LEGACY_KEYS); the
// settings are written there exactly as its own web app's setters write them (JSON values, the account's per-user
// maps beside desktopConfig, a storage event per key), so its hooks re-read them and hand the config to main as a
// settings change does.

export const LEGACY_ORIGIN = "filendesktop://bundle"

const INSPECTOR_TIMEOUT_MS = 60_000

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
// do), keyed by the pair's uuid, and every message type for diagnostics.
export async function watchLegacySync(page: Page): Promise<void> {
	await page.evaluate(`(() => {
		if (globalThis.__e2eSync) return
		const state = (globalThis.__e2eSync = { quiet: {}, types: {} })
		window.desktopAPI.onMainToWindowMessage(message => {
			if (!message || message.type !== "sync" || !message.message) return
			const type = String(message.message.type)
			state.types[type] = (state.types[type] ?? 0) + 1
			const uuid = message.message.syncPair && message.message.syncPair.uuid
			if (type === "cycleNoChanges" && typeof uuid === "string") state.quiet[uuid] = (state.quiet[uuid] ?? 0) + 1
		})
	})()`)
}

export async function legacySyncCounts(page: Page): Promise<{ quiet: Record<string, number>; types: Record<string, number> }> {
	return (await page.evaluate("globalThis.__e2eSync ?? { quiet: {}, types: {} }")) as {
		quiet: Record<string, number>
		types: Record<string, number>
	}
}

// What the old settings dialogs write: prefs (tray, start minimized), the PIN and its lock timeout, the network drive,
// WebDAV and the sync pairs, for the signed-in account.
export async function configureLegacy(page: Page, settings: LegacySettings): Promise<string[]> {
	const keys = await page.evaluate(
		`((keys, input) => {
			const parse = (key, fallback) => {
				try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback } catch { return fallback }
			}
			const config = parse(keys.desktopConfig, null)
			const userId = parse(keys.sdkConfig, {}).userId
			if (config === null || !(userId > 1)) throw new Error("the old app holds no desktopConfig or account")
			const next = {
				...config,
				syncConfig: { ...config.syncConfig, enabled: true, syncPairs: input.pairs },
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
				writes[key] = { ...(users !== null && typeof users === "object" && !Array.isArray(users) ? users : {}), [userId]: next[section] }
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

async function inspector(port: number): Promise<Cdp> {
	const targets = await waitFor(`the old main process's inspector on port ${String(port)}`, INSPECTOR_TIMEOUT_MS, async () => {
		const list = await listTargets(port)

		return list?.some(entry => entry.webSocketDebuggerUrl !== undefined) === true ? list : null
	})

	return connectCdp(targets.find(entry => entry.webSocketDebuggerUrl !== undefined)?.webSocketDebuggerUrl ?? fail("no inspector target"))
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

// Holds the old app's sync during its update launch. Its updater starts before its sync worker, but the download and
// the install race the first sync cycle, which would carry the closed-app edits before 4.x sees them. Before any of
// its code runs (--inspect-brk), a module-load hook wraps its worker's invoke so that sync starts and sync updates are
// dropped; the updater itself is untouched. The hold reports itself in globalThis.__e2eSyncHold.
const HOLD_SYNC = `(() => {
	const Module = process.getBuiltinModule("module")
	const state = (globalThis.__e2eSyncHold = { patched: false, dropped: [] })
	const load = Module._load
	Module._load = function (...args) {
		const exported = load.apply(this, args)
		const Worker = exported && exported.Worker
		if (!state.patched && typeof Worker === "function" && Worker.prototype && typeof Worker.prototype.invoke === "function") {
			const invoke = Worker.prototype.invoke
			Worker.prototype.invoke = function (channel, data) {
				if (channel === "restartSync" || channel === "startSync" || String(channel).startsWith("sync")) {
					state.dropped.push(String(channel))
					return Promise.resolve(undefined)
				}
				return invoke.call(this, channel, data)
			}
			state.patched = true
		}
		return exported
	}
	return "hooked"
})()`

export interface SyncHold {
	args: string[]
	// Installs the hold, lets the app run and waits until its worker is wrapped; the dropped calls so far.
	started(): Promise<string[]>
}

export async function legacySyncHold(): Promise<SyncHold> {
	const port = await freePort()

	return {
		args: [`--inspect-brk=127.0.0.1:${String(port)}`],
		async started() {
			const cdp = await inspector(port)

			try {
				if ((await cdp.evaluate(HOLD_SYNC)) !== "hooked") {
					fail("the sync hold did not install")
				}

				const paused = cdp.nextEvent("Debugger.paused", INSPECTOR_TIMEOUT_MS)

				// Awaited below; this only keeps a rejection before then from going unhandled.
				paused.catch(() => undefined)
				await cdp.send("Debugger.enable")
				await cdp.send("Runtime.runIfWaitingForDebugger")
				await paused
				await cdp.send("Debugger.resume")

				return await waitFor("the old sync worker to be held", INSPECTOR_TIMEOUT_MS, async () => {
					const state = (await cdp.evaluate("globalThis.__e2eSyncHold")) as { patched?: boolean; dropped?: string[] } | undefined

					return state?.patched === true ? (state.dropped ?? []) : null
				})
			} finally {
				// Detached, so nothing holds the process at its exit for the update.
				cdp.close()
			}
		}
	}
}
