import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createDragOutAddonWin, dragOutAddonWinPath, type DragOutAddonWinContext } from "../main/dragOut/addonWin.ts"

function context(overrides: Partial<DragOutAddonWinContext> = {}): DragOutAddonWinContext {
	return {
		packaged: false,
		resourcesPath: "C:\\Program Files\\Filen\\resources",
		appPath: "/repo/packages/filen-desktop",
		platform: "win32",
		arch: "x64",
		exists: () => true,
		load: () => ({}),
		...overrides
	}
}

describe("dragOutAddonWinPath", () => {
	it("uses the shipped addon when packaged, else the staged copy for this arch", () => {
		expect(dragOutAddonWinPath(context({ packaged: true }))).toBe(
			path.join("C:\\Program Files\\Filen\\resources", "native", "filen-drag.node")
		)
		expect(dragOutAddonWinPath(context({ arch: "arm64" }))).toBe(
			path.join("/repo/packages/filen-desktop", "build", "native", "win-arm64", "filen-drag.node")
		)
	})

	it("is null when the file is missing", () => {
		expect(dragOutAddonWinPath(context({ exists: () => false }))).toBeNull()
		expect(dragOutAddonWinPath(context({ packaged: true, exists: () => false }))).toBeNull()
	})

	it("is null off Windows", () => {
		expect(dragOutAddonWinPath(context({ platform: "darwin" }))).toBeNull()
		expect(dragOutAddonWinPath(context({ platform: "linux" }))).toBeNull()
	})
})

describe("createDragOutAddonWin", () => {
	it("loads the addon once, on first use", () => {
		const addon = {}
		const load = vi.fn(() => addon)
		const get = createDragOutAddonWin(context({ load }))

		expect(load).not.toHaveBeenCalled()
		expect(get()).toBe(addon)
		expect(get()).toBe(addon)
		expect(load).toHaveBeenCalledTimes(1)
		expect(load).toHaveBeenCalledWith(path.join("/repo/packages/filen-desktop", "build", "native", "win-x64", "filen-drag.node"))
	})

	it("never loads off Windows or when the file is missing", () => {
		const load = vi.fn()

		expect(createDragOutAddonWin(context({ platform: "linux", load }))()).toBeNull()
		expect(createDragOutAddonWin(context({ exists: () => false, load }))()).toBeNull()
		expect(load).not.toHaveBeenCalled()
	})

	it("retries after a failed load", () => {
		const addon = {}
		const load = vi
			.fn<(file: string) => unknown>()
			.mockImplementationOnce(() => {
				throw new Error("LoadLibrary failed")
			})
			.mockReturnValue(addon)
		const get = createDragOutAddonWin(context({ load }))

		expect(() => get()).toThrow("LoadLibrary failed")
		expect(get()).toBe(addon)
	})
})
