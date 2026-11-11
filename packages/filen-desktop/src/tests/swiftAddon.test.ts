import path from "node:path"
import { describe, expect, it } from "vitest"
import { isUpToDate, swiftAddonInputs, swiftAddonSources } from "../../scripts/swiftAddon.ts"

const nativeDir = path.join(import.meta.dirname, "..", "..", "native")

describe("swiftAddon", () => {
	it("compiles an addon's own sources with the shared helpers", () => {
		const sources = swiftAddonSources("fileProvider")

		expect(sources).toContain(path.join(nativeDir, "fileProvider", "FileProviderAddon.swift"))
		expect(sources).toContain(path.join(nativeDir, "shared", "NodeValues.swift"))
		expect(sources.every(file => file.endsWith(".swift"))).toBe(true)
	})

	it("counts the shared helpers and the Node-API module map as inputs", () => {
		const inputs = swiftAddonInputs("fileProvider")

		expect(inputs).toEqual(expect.arrayContaining(swiftAddonSources("fileProvider")))
		expect(inputs).toContain(path.join(nativeDir, "shared", "NodeAPI", "module.modulemap"))
		expect(inputs).toContain(path.join(nativeDir, "shared", "NodeAPI", "NodeAPI.h"))
	})

	it("is up to date only while the output is newer than every input", () => {
		const mtimes: Record<string, number> = { "/out.node": 20, "/a.swift": 10, "/shared/b.swift": 15 }
		const mtime = (file: string) => mtimes[file] ?? null

		expect(isUpToDate("/out.node", ["/a.swift", "/shared/b.swift"], mtime)).toBe(true)
		mtimes["/shared/b.swift"] = 25
		expect(isUpToDate("/out.node", ["/a.swift", "/shared/b.swift"], mtime)).toBe(false)
		expect(isUpToDate("/missing.node", ["/a.swift"], mtime)).toBe(false)
	})
})
