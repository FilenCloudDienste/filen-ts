import path from "node:path"
import { fileURLToPath } from "node:url"
import type { NativeArch } from "./nativeArch.ts"

// What the build and staging scripts share. electron-builder's ${os} per platform is BUILDER_OS
// (src/shared/buildLayout.ts), which the app's development lookups read too.

// packages/filen-desktop.
export const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The architectures the app builds for, on every OS.
export const ARCHS: readonly NativeArch[] = ["x64", "arm64"]

// Apple's name for each architecture (Swift target triples, lipo).
export const APPLE_ARCH: Readonly<Record<NativeArch, string>> = { x64: "x86_64", arm64: "arm64" }

const appleArchByName: Readonly<Partial<Record<string, string>>> = APPLE_ARCH

// Apple's name for `arch`; undefined for one the app does not build for.
export function appleArch(arch: string): string | undefined {
	return appleArchByName[arch]
}
