import path from "node:path"

// { arch: sha256 } of the Linux rclone this build ships, baked into the main bundle by scripts/build.ts; {} on macOS
// and Windows, where the binary carries the app's signature instead, and in tests.
declare const __FILEN_RCLONE_SHA256__: Readonly<Partial<Record<string, string>>> | undefined

export const bakedRcloneSha256: Readonly<Partial<Record<string, string>>> =
	typeof __FILEN_RCLONE_SHA256__ === "undefined" ? {} : __FILEN_RCLONE_SHA256__

export interface RclonePathContext {
	packaged: boolean
	resourcesPath: string
	env: NodeJS.ProcessEnv
	appPath: string
	platform: NodeJS.Platform
	arch: string
	sha256: Readonly<Partial<Record<string, string>>>
	exists(file: string): boolean
}

export interface RclonePaths {
	// What the native host runs; `sha256` is checked before every start where nothing re-signs the binary (Linux).
	binary: { path: string; sha256: string | null }
	// The bundled WinFsp MSI (Windows), null where the app ships no FUSE installer.
	fuseInstaller: string | null
}

// electron-builder's ${os}, which names the staged directories.
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", win32: "win", linux: "linux" }

// The bundled rclone: shipped in resources/rclone when packaged; in development FILEN_DESKTOP_RCLONE, else the copy
// scripts/stageRclone.ts staged. null when there is none, and for a packaged Linux build without its baked digest,
// which would otherwise run an unchecked binary.
export function rclonePaths(ctx: RclonePathContext): RclonePaths | null {
	const executable = ctx.platform === "win32" ? "rclone.exe" : "rclone"
	const installer = (file: string) => (ctx.platform === "win32" && ctx.exists(file) ? file : null)

	if (ctx.packaged) {
		const shipped = path.join(ctx.resourcesPath, "rclone", executable)
		const sha256 = ctx.platform === "linux" ? (ctx.sha256[ctx.arch] ?? null) : null

		if (!ctx.exists(shipped) || (ctx.platform === "linux" && sha256 === null)) {
			return null
		}

		return { binary: { path: shipped, sha256 }, fuseInstaller: installer(path.join(ctx.resourcesPath, "deps", "winfsp.msi")) }
	}

	const fuseInstaller = installer(path.join(ctx.appPath, "build", "deps", "win", "winfsp.msi"))
	const override = ctx.env["FILEN_DESKTOP_RCLONE"]

	if (override !== undefined && override.length > 0) {
		return ctx.exists(override) ? { binary: { path: path.resolve(override), sha256: null }, fuseInstaller } : null
	}

	const staged = path.join(ctx.appPath, "build", "rclone", `${BUILDER_OS[ctx.platform] ?? ctx.platform}-${ctx.arch}`, executable)

	return ctx.exists(staged) ? { binary: { path: staged, sha256: null }, fuseInstaller } : null
}
