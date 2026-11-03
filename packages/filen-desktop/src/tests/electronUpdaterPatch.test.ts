import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppAdapter } from "electron-updater/out/AppAdapter.js"
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater.js"
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js"
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js"

// The patched electron-updater (patches/electron-updater@6.8.11.patch). The installers are shell scripts, so this runs
// where they execute.
const POSIX = process.platform !== "win32"

function fakeApp(dir: string): AppAdapter & { quit: ReturnType<typeof vi.fn<() => void>> } {
	return {
		version: "4.0.0",
		name: "Filen",
		isPackaged: true,
		appUpdateConfigPath: path.join(dir, "app-update.yml"),
		userDataPath: dir,
		baseCachePath: dir,
		whenReady: () => Promise.resolve(),
		relaunch: () => undefined,
		quit: vi.fn<() => void>(),
		onQuit: () => undefined
	}
}

function script(file: string, body: string): string {
	writeFileSync(file, `#!/bin/sh\n${body}\n`)
	chmodSync(file, 0o755)

	return file
}

async function helperFor(dir: string, file: string, isAdminRightsRequired: boolean): Promise<DownloadedUpdateHelper> {
	const helper = new DownloadedUpdateHelper(path.join(dir, "cache"))
	const name = path.basename(file)

	await helper.setDownloadedFile(
		file,
		null,
		{ version: "4.0.1", files: [], path: name, sha512: "", releaseDate: "" },
		{ url: new URL(`https://cdn.filen.io/${name}`), info: { url: name, sha512: "", isAdminRightsRequired } },
		name,
		false
	)

	return helper
}

class TestAppImageUpdater extends AppImageUpdater {
	use(helper: DownloadedUpdateHelper): void {
		this.downloadedUpdateHelper = helper
	}

	runInstall(): boolean {
		return this.doInstall({ isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false })
	}
}

class TestNsisUpdater extends NsisUpdater {
	use(helper: DownloadedUpdateHelper): void {
		this.downloadedUpdateHelper = helper
	}
}

let dir: string

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "filen-updater-"))
	mkdirSync(path.join(dir, "cache"))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe.runIf(POSIX)("AppImageUpdater", () => {
	async function updater(appImage: string, download: string): Promise<TestAppImageUpdater> {
		const result = new TestAppImageUpdater(null, fakeApp(dir))

		result.logger = null
		result.use(await helperFor(dir, download, false))
		vi.stubEnv("APPIMAGE", appImage)

		return result
	}

	it("replaces an AppImage without a version in its name in place", async () => {
		const appImage = script(path.join(dir, "Filen.AppImage"), "exit 0 # old")
		const download = script(path.join(dir, "cache-Filen-4.0.1.AppImage"), "exit 0 # new")

		expect((await updater(appImage, download)).runInstall()).toBe(true)
		expect(readFileSync(appImage, "utf8")).toContain("# new")
		expect(existsSync(download)).toBe(false)
		expect(readdirSync(dir).filter(name => name.endsWith(".update"))).toEqual([])
	})

	it("moves a versioned AppImage to the new name, then removes the old one", async () => {
		const appImage = script(path.join(dir, "Filen-4.0.0.AppImage"), "exit 0 # old")
		const download = script(path.join(dir, "cache", "Filen-4.0.1.AppImage"), "exit 0 # new")

		expect((await updater(appImage, download)).runInstall()).toBe(true)
		expect(existsSync(appImage)).toBe(false)
		expect(readFileSync(path.join(dir, "Filen-4.0.1.AppImage"), "utf8")).toContain("# new")
	})

	it.each([
		["in place", "Filen.AppImage"],
		["to a new name", "Filen-4.0.0.AppImage"]
	])("keeps the running AppImage when the move %s fails", async (_case, name) => {
		const appImage = script(path.join(dir, name), "exit 0 # old")
		const missing = path.join(dir, "cache", "Filen-4.0.1.AppImage")
		const install = await updater(appImage, missing)

		expect(() => install.runInstall()).toThrow()
		expect(readFileSync(appImage, "utf8")).toContain("# old")
		expect(readdirSync(dir).filter(name => name.endsWith(".update"))).toEqual([])
	})
})

describe.runIf(POSIX)("NsisUpdater", () => {
	beforeEach(() => {
		Object.defineProperty(process, "resourcesPath", { value: dir, configurable: true, writable: true })
	})

	afterEach(() => {
		Reflect.deleteProperty(process, "resourcesPath")
	})

	it("keeps the app running when the elevation is declined, and tries again on the next install", async () => {
		const launches = path.join(dir, "launches")

		// elevate.exe's answer to a declined UAC prompt (ERROR_CANCELLED).
		script(path.join(dir, "elevate.exe"), `echo "$@" >> "${launches}"\nexit 1223`)

		const app = fakeApp(dir)
		const updater = new TestNsisUpdater(null, app)

		updater.logger = null
		updater.use(await helperFor(dir, script(path.join(dir, "Filen-Setup-4.0.1.exe"), "exit 0"), true))

		for (const attempt of [1, 2]) {
			const failed = new Promise<Error>(resolve => updater.once("error", resolve))

			updater.quitAndInstall(true, true)
			expect((await failed).message).toContain("elevate.exe exited with code")
			await new Promise(resolve => setImmediate(resolve))
			expect(app.quit).not.toHaveBeenCalled()
			expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(attempt)
		}

		expect(readFileSync(launches, "utf8")).toContain("--updated /S --force-run")
	})

	it("keeps the app running when elevate.exe cannot start", async () => {
		const app = fakeApp(dir)
		const updater = new TestNsisUpdater(null, app)

		updater.logger = null
		updater.use(await helperFor(dir, script(path.join(dir, "Filen-Setup-4.0.1.exe"), "exit 0"), true))

		const failed = new Promise<Error>(resolve => updater.once("error", resolve))

		updater.quitAndInstall(true, true)
		expect((await failed).message).toContain("ENOENT")
		await new Promise(resolve => setImmediate(resolve))
		expect(app.quit).not.toHaveBeenCalled()
	})
})
