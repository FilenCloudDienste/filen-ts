import { type ConfigPlugin, withPodfile } from "expo/config-plugins"

const MARKER = "# withBlake3SymbolRename"
const POST_INSTALL = /^([ \t]*)post_install do \|installer\|[ \t]*$/m

// The Rust blake3 crate in @filen/sdk-rs exports blake3_compress_in_place_portable for its NEON C, and these
// pods compile the BLAKE3 C reference, which defines the same symbol: rename it in the C copies so ld sees one definition.
const POD_TARGETS = ["FileHash", "QuickCrypto"]
const DEFINE = "blake3_compress_in_place_portable=blake3c_compress_in_place_portable"

// Pure Podfile transform, exported for tests. Idempotent: prebuild without --clean reruns it on an already patched Podfile.
export function applyBlake3SymbolRename(contents: string): string {
	if (contents.includes(MARKER)) {
		return contents
	}

	const match = contents.match(POST_INSTALL)

	if (!match || match.index === undefined) {
		throw new Error("Unable to locate the post_install hook in ios/Podfile. The Expo prebuild template may have changed.")
	}

	const indent = `${match[1] ?? ""}  `
	const snippet = [
		`${indent}${MARKER}`,
		`${indent}installer.pods_project.targets.each do |target|`,
		`${indent}  next unless ${JSON.stringify(POD_TARGETS)}.include?(target.name)`,
		`${indent}  target.build_configurations.each do |build_config|`,
		`${indent}    defines = build_config.build_settings["GCC_PREPROCESSOR_DEFINITIONS"] || "$(inherited)"`,
		`${indent}    build_config.build_settings["GCC_PREPROCESSOR_DEFINITIONS"] = [*defines, "${DEFINE}"]`,
		`${indent}  end`,
		`${indent}end`
	].join("\n")
	const end = match.index + match[0].length

	return `${contents.slice(0, end)}\n${snippet}${contents.slice(end)}`
}

const withBlake3SymbolRename: ConfigPlugin = config => {
	return withPodfile(config, config => {
		config.modResults.contents = applyBlake3SymbolRename(config.modResults.contents)

		return config
	})
}

export default withBlake3SymbolRename
