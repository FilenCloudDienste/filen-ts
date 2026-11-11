import type { NativeArch } from "./nativeArch.ts"
import { buildSwiftAddon, type SwiftAddon, swiftAddonOutput } from "./swiftAddon.ts"

// Builds the macOS addon (native/mac: quarantine for downloads) to build/native/mac-<arch>/filen-mac.node
// (scripts/swiftAddon.ts). It runs wherever the app does, so it targets the app's macOS floor (13.0) and uses nothing
// newer. A no-op on other hosts.
//
// `--dev` builds this machine's architecture only, and nothing while the addon is newer than its sources.
//
//   node scripts/buildMacAddon.ts [--dev]

export const MAC_ADDON: SwiftAddon = { name: "buildMacAddon", sourceDir: "mac", module: "FilenMac", file: "filen-mac.node", macos: "13.0" }

export function macAddonOutput(arch: NativeArch): string {
	return swiftAddonOutput(MAC_ADDON.file, arch)
}

export function buildMacAddon(options: { dev: boolean }): void {
	buildSwiftAddon(MAC_ADDON, options)
}

if (import.meta.main) {
	buildMacAddon({ dev: process.argv.includes("--dev") })
}
