import path from "node:path"
import { describe, expect, it } from "vitest"
import { MAC_ADDON, macAddonOutput } from "../../scripts/buildMacAddon.ts"
import { isUpToDate, swiftAddonInputs, swiftAddonSources } from "../../scripts/swiftAddon.ts"

const packageDir = path.join(import.meta.dirname, "..", "..")

describe("buildMacAddon", () => {
	it("output paths per arch", () => {
		expect(macAddonOutput("arm64")).toBe(path.join(packageDir, "build", "native", "mac-arm64", "filen-mac.node"))
		expect(macAddonOutput("x64")).toBe(path.join(packageDir, "build", "native", "mac-x64", "filen-mac.node"))
	})

	it("targets the app's macOS floor", () => {
		expect(MAC_ADDON).toMatchObject({ sourceDir: "mac", module: "FilenMac", file: "filen-mac.node", macos: "13.0" })
	})

	it("dev skips when the output is newer than every source including native/shared", () => {
		const inputs = swiftAddonInputs(MAC_ADDON.sourceDir)
		const shared = path.join(packageDir, "native", "shared", "NodeValues.swift")

		expect(swiftAddonSources(MAC_ADDON.sourceDir)).toContain(path.join(packageDir, "native", "mac", "Quarantine.swift"))
		expect(inputs).toContain(shared)

		const output = macAddonOutput("arm64")
		const mtime = (file: string) => (file === output ? 100 : file === shared ? 50 : 10)

		expect(isUpToDate(output, inputs, mtime)).toBe(true)
		expect(isUpToDate(output, inputs, file => (file === output ? 100 : file === shared ? 150 : 10))).toBe(false)
	})
})
