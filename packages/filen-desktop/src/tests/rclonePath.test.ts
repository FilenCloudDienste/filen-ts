import path from "node:path"
import { describe, expect, it } from "vitest"
import { bakedRcloneSha256, rclonePaths, type RclonePathContext } from "../main/mounts/rclonePath.ts"

const SHA = "a".repeat(64)

function context(overrides: Partial<RclonePathContext> = {}): RclonePathContext {
	return {
		packaged: false,
		resourcesPath: "/App/Contents/Resources",
		env: {},
		appPath: "/repo/packages/filen-desktop",
		platform: "darwin",
		arch: "arm64",
		sha256: {},
		exists: () => true,
		...overrides
	}
}

describe("rclonePaths", () => {
	it("uses the shipped binary when packaged, signed on macOS and Windows", () => {
		expect(rclonePaths(context({ packaged: true, env: { FILEN_DESKTOP_RCLONE: "/elsewhere/rclone" } }))).toEqual({
			binary: { path: path.join("/App/Contents/Resources", "rclone", "rclone"), sha256: null },
			fuseInstaller: null
		})
		expect(rclonePaths(context({ packaged: true, platform: "win32", resourcesPath: "/Filen/resources", arch: "x64" }))).toEqual({
			binary: { path: path.join("/Filen/resources", "rclone", "rclone.exe"), sha256: null },
			fuseInstaller: path.join("/Filen/resources", "deps", "winfsp.msi")
		})
		expect(rclonePaths(context({ packaged: true, exists: () => false }))).toBeNull()
	})

	it("hands the baked digest along on Linux and refuses a build without one", () => {
		const linux = context({ packaged: true, platform: "linux", resourcesPath: "/opt/Filen/resources", arch: "x64" })

		expect(rclonePaths({ ...linux, sha256: { x64: SHA } })).toEqual({
			binary: { path: path.join("/opt/Filen/resources", "rclone", "rclone"), sha256: SHA },
			fuseInstaller: null
		})
		expect(rclonePaths({ ...linux, sha256: { arm64: SHA } })).toBeNull()
	})

	it("offers the WinFsp installer only when it is there", () => {
		const win = context({ packaged: true, platform: "win32", resourcesPath: "/Filen/resources" })

		expect(rclonePaths({ ...win, exists: file => !file.endsWith("winfsp.msi") })?.fuseInstaller).toBeNull()
	})

	it("prefers the development override, then the staged copy", () => {
		expect(rclonePaths(context({ env: { FILEN_DESKTOP_RCLONE: "/usr/local/bin/rclone" } }))?.binary).toEqual({
			path: "/usr/local/bin/rclone",
			sha256: null
		})
		expect(rclonePaths(context({ env: { FILEN_DESKTOP_RCLONE: "/missing" }, exists: file => file !== "/missing" }))).toBeNull()
		expect(rclonePaths(context())?.binary.path).toBe(
			path.join("/repo/packages/filen-desktop", "build", "rclone", "mac-arm64", "rclone")
		)
		expect(rclonePaths(context({ platform: "win32", arch: "x64" }))).toEqual({
			binary: { path: path.join("/repo/packages/filen-desktop", "build", "rclone", "win-x64", "rclone.exe"), sha256: null },
			fuseInstaller: path.join("/repo/packages/filen-desktop", "build", "deps", "win", "winfsp.msi")
		})
		expect(rclonePaths(context({ exists: () => false }))).toBeNull()
	})

	it("bakes nothing outside the production bundle", () => {
		expect(bakedRcloneSha256).toEqual({})
	})
})
