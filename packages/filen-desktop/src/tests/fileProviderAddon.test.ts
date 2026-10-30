import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	bundledAppexPath,
	createFileProviderAddon,
	fileProviderAddonPath,
	type FileProviderAddonContext
} from "../main/fileProvider/addon.ts"

function context(overrides: Partial<FileProviderAddonContext> = {}): FileProviderAddonContext {
	return {
		packaged: false,
		resourcesPath: "/App/Contents/Resources",
		appPath: "/repo/packages/filen-desktop",
		platform: "darwin",
		arch: "arm64",
		release: "23.0.0",
		execPath: "/Applications/Filen.app/Contents/MacOS/Filen",
		exists: () => true,
		load: () => ({}),
		...overrides
	}
}

describe("fileProviderAddonPath", () => {
	it("uses the shipped addon when packaged, else the staged copy", () => {
		expect(fileProviderAddonPath(context({ packaged: true }))).toBe(path.join("/App/Contents/Resources", "native", "filen-fp.node"))
		expect(fileProviderAddonPath(context({ arch: "x64", release: "25.1.0" }))).toBe(
			path.join("/repo/packages/filen-desktop", "build", "native", "mac-x64", "filen-fp.node")
		)
		expect(fileProviderAddonPath(context({ exists: () => false }))).toBeNull()
		expect(fileProviderAddonPath(context({ packaged: true, exists: () => false }))).toBeNull()
	})

	it("is null when the running bundle has no extension, as in an unpackaged run", () => {
		const appex = "/Applications/Filen.app/Contents/PlugIns/FilenFileProvider.appex"
		const dev = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

		expect(bundledAppexPath("/Applications/Filen.app/Contents/MacOS/Filen")).toBe(appex)
		expect(fileProviderAddonPath(context({ exists: file => file !== appex, packaged: true }))).toBeNull()
		expect(fileProviderAddonPath(context({ execPath: dev, exists: file => !file.endsWith(".appex") }))).toBeNull()
		expect(fileProviderAddonPath(context({ execPath: dev, exists: file => file !== bundledAppexPath(dev) }))).toBeNull()
	})

	it("is null below macOS 14 and off macOS", () => {
		expect(fileProviderAddonPath(context({ release: "22.6.0" }))).toBeNull()
		expect(fileProviderAddonPath(context({ release: "" }))).toBeNull()
		expect(fileProviderAddonPath(context({ platform: "linux", release: "6.8.0" }))).toBeNull()
		expect(fileProviderAddonPath(context({ platform: "win32", release: "10.0.26100" }))).toBeNull()
	})
})

describe("createFileProviderAddon", () => {
	it("loads the addon once, on first use", () => {
		const addon = {}
		const load = vi.fn(() => addon)
		const get = createFileProviderAddon(context({ load }))

		expect(load).not.toHaveBeenCalled()
		expect(get()).toBe(addon)
		expect(get()).toBe(addon)
		expect(load).toHaveBeenCalledTimes(1)
		expect(load).toHaveBeenCalledWith(path.join("/repo/packages/filen-desktop", "build", "native", "mac-arm64", "filen-fp.node"))
	})

	it("never loads where File Provider is unsupported or the extension is missing", () => {
		const load = vi.fn()
		const get = createFileProviderAddon(context({ release: "22.6.0", load }))

		expect(createFileProviderAddon(context({ load, exists: file => !file.endsWith(".appex") }))()).toBeNull()
		expect(get()).toBeNull()
		expect(get()).toBeNull()
		expect(load).not.toHaveBeenCalled()
	})

	it("retries after a failed load", () => {
		const addon = {}
		const load = vi
			.fn<(file: string) => unknown>()
			.mockImplementationOnce(() => {
				throw new Error("dlopen failed")
			})
			.mockReturnValue(addon)
		const get = createFileProviderAddon(context({ load }))

		expect(() => get()).toThrow("dlopen failed")
		expect(get()).toBe(addon)
	})
})
