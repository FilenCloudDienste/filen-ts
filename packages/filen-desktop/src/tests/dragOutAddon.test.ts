import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createDragOutAddon, type DragOutAddonContext } from "../main/dragOut/addon.ts"
import { dragFakes, dragImage, dragItem, preparedId } from "./dragOutFakes.ts"

function context(overrides: Partial<DragOutAddonContext> = {}): DragOutAddonContext {
	return {
		packaged: true,
		resourcesPath: "/App/Contents/Resources",
		appPath: "/repo/packages/filen-desktop",
		platform: "darwin",
		arch: "arm64",
		exists: () => true,
		load: () => ({}),
		warn: () => undefined,
		...overrides
	}
}

describe("createDragOutAddon", () => {
	it("loads filen-mac.node from the resources path on darwin", () => {
		const addon = {}
		const load = vi.fn(() => addon)

		expect(createDragOutAddon(context({ load }))).toBe(addon)
		expect(load).toHaveBeenCalledWith(path.join("/App/Contents/Resources", "native", "filen-mac.node"))
		expect(createDragOutAddon(context({ packaged: false, arch: "x64", load }))).toBe(addon)
		expect(load).toHaveBeenLastCalledWith(path.join("/repo/packages/filen-desktop", "build", "native", "mac-x64", "filen-mac.node"))
	})

	it("returns null on linux and when the file is missing", () => {
		const load = vi.fn()

		expect(createDragOutAddon(context({ platform: "linux", load }))).toBeNull()
		expect(createDragOutAddon(context({ platform: "win32", load }))).toBeNull()
		expect(createDragOutAddon(context({ exists: () => false, load }))).toBeNull()
		expect(load).not.toHaveBeenCalled()
	})

	it("returns null and warns when the addon does not load", () => {
		const warn = vi.fn()
		const load = () => {
			throw new Error("dlopen failed")
		}

		expect(createDragOutAddon(context({ load, warn }))).toBeNull()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("dlopen failed"))
	})
})

describe("the macOS addon's begin", () => {
	it("is given Finder's failure text from the shell strings", async () => {
		const f = dragFakes("promise")
		const page = f.page(1)
		const id = await preparedId(f.service.prepare(page, [dragItem("a.txt")]))

		void f.service.begin(page, id, dragImage())

		expect(f.mac.begins[0]?.failureMessage).toBe("Filen could not download this item.")
	})
})
