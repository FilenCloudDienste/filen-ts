import { describe, it, expect } from "vitest"
import plist from "@expo/plist"
// plugins/ sits outside src/, so no "@/" alias — relative import is fine in tests.
import { fileProviderActionKeys, getFileProviderInfoContent, type FileProviderPluginProps } from "../../plugins/withFileProvider"

const ACTIONS = [
	{
		NSExtensionFileProviderActionIdentifier: "io.filen.fileprovider.action.keepDownloaded",
		NSExtensionFileProviderActionName: "Keep Downloaded",
		NSExtensionFileProviderActionActivationRule: "SUBQUERY(fileproviderItems, $item, $item.userInfo.pinnable == true).@count > 0"
	}
]

const providerPlist = (extension: Record<string, unknown>) =>
	plist.build({
		CFBundleName: "$(PRODUCT_NAME)",
		NSExtension: {
			NSExtensionPointIdentifier: "com.apple.fileprovider-nonui",
			...extension
		}
	})

const PROVIDER_PLIST = providerPlist({
	NSExtensionFileProviderActions: ACTIONS,
	NSExtensionFileProviderAllowsUserControlledEviction: false
})

const PROPS: FileProviderPluginProps = {
	libName: "filen_mobile_native_cache",
	crateName: "filen-mobile-native-cache",
	targets: [],
	iosAppGroupIdentifier: "group.io.filen.app",
	developmentTeamId: "TEAM"
}

describe("fileProviderActionKeys", () => {
	it("copies the actions and the eviction switch from the provider's Info.plist", () => {
		expect(fileProviderActionKeys(PROVIDER_PLIST)).toEqual({
			NSExtensionFileProviderActions: ACTIONS,
			NSExtensionFileProviderAllowsUserControlledEviction: false
		})
	})

	it("throws when the provider lacks either key, so the plugin and the provider cannot drift apart", () => {
		expect(() => fileProviderActionKeys(providerPlist({ NSExtensionFileProviderAllowsUserControlledEviction: false }))).toThrow(
			/NSExtensionFileProviderActions/
		)
		expect(() =>
			fileProviderActionKeys(providerPlist({ NSExtensionFileProviderActions: [], NSExtensionFileProviderAllowsUserControlledEviction: false }))
		).toThrow(/NSExtensionFileProviderActions/)
		expect(() => fileProviderActionKeys(providerPlist({ NSExtensionFileProviderActions: ACTIONS }))).toThrow(
			/NSExtensionFileProviderAllowsUserControlledEviction/
		)
		expect(() => fileProviderActionKeys(plist.build({ CFBundleName: "x" }))).toThrow(/NSExtension/)
	})
})

describe("getFileProviderInfoContent", () => {
	it("puts the copied keys into the generated extension's NSExtension dictionary", () => {
		const generated = plist.parse(getFileProviderInfoContent("Filen", PROPS, fileProviderActionKeys(PROVIDER_PLIST))) as {
			NSExtension: Record<string, unknown>
		}

		expect(generated.NSExtension["NSExtensionFileProviderActions"]).toEqual(ACTIONS)
		expect(generated.NSExtension["NSExtensionFileProviderAllowsUserControlledEviction"]).toBe(false)
		expect(generated.NSExtension["NSExtensionPointIdentifier"]).toBe("com.apple.fileprovider-nonui")
	})
})
