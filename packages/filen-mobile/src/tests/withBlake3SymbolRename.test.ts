import { describe, it, expect } from "vitest"
// plugins/ sits outside src/, so no "@/" alias — relative import is fine in tests.
import { applyBlake3SymbolRename } from "../../plugins/withBlake3SymbolRename"

// Mirrors the Expo prebuild template's ios/Podfile post_install hook.
const TEMPLATE = `target 'Filen' do
  use_react_native!()

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
    )
  end
end
`

describe("applyBlake3SymbolRename", () => {
	it("renames the portable symbol for the FileHash and QuickCrypto pods only, inside post_install", () => {
		const out = applyBlake3SymbolRename(TEMPLATE)
		const hook = out.slice(out.indexOf("post_install do |installer|"), out.indexOf("react_native_post_install("))

		expect(out.endsWith(TEMPLATE.slice(TEMPLATE.indexOf("    react_native_post_install(")))).toBe(true)
		// The blank line before the hook must not leak into the inserted lines' indent.
		expect(hook).toBe(
			[
				"post_install do |installer|",
				"    # withBlake3SymbolRename",
				"    installer.pods_project.targets.each do |target|",
				'      next unless ["FileHash","QuickCrypto"].include?(target.name)',
				"      target.build_configurations.each do |build_config|",
				'        defines = build_config.build_settings["GCC_PREPROCESSOR_DEFINITIONS"] || "$(inherited)"',
				'        build_config.build_settings["GCC_PREPROCESSOR_DEFINITIONS"] = [*defines, "blake3_compress_in_place_portable=blake3c_compress_in_place_portable"]',
				"      end",
				"    end",
				"    "
			].join("\n")
		)
	})

	it("is idempotent across repeated prebuilds", () => {
		const once = applyBlake3SymbolRename(TEMPLATE)

		expect(applyBlake3SymbolRename(once)).toBe(once)
	})

	it("throws when the post_install hook is missing (template shape changed)", () => {
		expect(() => applyBlake3SymbolRename("target 'Filen' do\nend\n")).toThrow(/post_install hook/)
	})
})
