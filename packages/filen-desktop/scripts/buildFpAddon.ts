import { buildSwiftAddon } from "./swiftAddon.ts"

// Builds the File Provider addon (native/fileProvider) to build/native/mac-<arch>/filen-fp.node (scripts/swiftAddon.ts).
// File Provider needs macOS 14, so it links against the Swift runtime that ships. A no-op on other hosts.
//
// `--dev` builds this machine's architecture only, and nothing while the addon is newer than its sources.
//
//   node scripts/buildFpAddon.ts [--dev]

export function buildFpAddon(options: { dev: boolean }): void {
	buildSwiftAddon(
		{ name: "buildFpAddon", sourceDir: "fileProvider", module: "FilenFileProvider", file: "filen-fp.node", macos: "14.0" },
		options
	)
}

if (import.meta.main) {
	buildFpAddon({ dev: process.argv.includes("--dev") })
}
