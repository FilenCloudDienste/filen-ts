import path from "node:path"
import { describe, expect, it } from "vitest"
import { addonPath, type AddonPathContext } from "../main/native/addonPath.ts"

function context(overrides: Partial<AddonPathContext> = {}): AddonPathContext {
	return {
		packaged: false,
		resourcesPath: "/App/Contents/Resources",
		env: {},
		appPath: "/repo/packages/filen-desktop",
		platform: "darwin",
		arch: "arm64",
		exists: () => true,
		...overrides
	}
}

describe("addonPath", () => {
	it("uses the shipped addon when packaged", () => {
		expect(addonPath(context({ packaged: true, env: { FILEN_DESKTOP_NAPI: "/elsewhere.node" } }))).toBe(
			path.join("/App/Contents/Resources", "native", "sdk-rs.node")
		)
		expect(addonPath(context({ packaged: true, exists: () => false }))).toBeNull()
	})

	it("prefers the development override, then the staged copy", () => {
		expect(addonPath(context({ env: { FILEN_DESKTOP_NAPI: "/rs/sdk-rs.darwin-arm64.node" } }))).toBe("/rs/sdk-rs.darwin-arm64.node")
		expect(addonPath(context())).toBe(path.join("/repo/packages/filen-desktop", "build", "native", "mac-arm64", "sdk-rs.node"))
		expect(addonPath(context({ exists: () => false }))).toBeNull()
	})
})
