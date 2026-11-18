// electron-builder's ${os} for each platform the app builds for. The staging scripts and the development lookups of
// the addon and rclone both name build/<kind>/<os>-<arch> from it. Node-free: the preload compiles src/shared too.
export const BUILDER_OS = { darwin: "mac", win32: "win", linux: "linux" } as const

export type BuilderOs = (typeof BUILDER_OS)[keyof typeof BUILDER_OS]

const builderOsByPlatform: Readonly<Partial<Record<string, BuilderOs>>> = BUILDER_OS

// electron-builder's ${os} for `platform`; undefined for one the app does not build for.
export function builderOs(platform: string): BuilderOs | undefined {
	return builderOsByPlatform[platform]
}

// The <os>-<arch> directory of build/<kind>/ that holds what was staged for `platform` and `arch`.
export function stagedDirName(platform: string, arch: string): string {
	return `${builderOs(platform) ?? platform}-${arch}`
}
