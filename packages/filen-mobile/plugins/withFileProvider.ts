import { ConfigPlugin } from "@expo/config-plugins"
import { withXcodeProject } from "@expo/config-plugins/build/plugins/ios-plugins"
import { withDangerousMod } from "@expo/config-plugins/build/plugins/withDangerousMod"
import { build } from "@expo/plist/build/build.js"
import { execSync } from "child_process"
import fs from "node:fs"
import path from "node:path"

type FileProviderPluginProps = {
	libName: string
	crateName: string
	targets: string[]
	cargoArgs?: string
	iosAppGroupIdentifier: string
	developmentTeamId: string
}

const EXTENSION_NAME = "FilenFileProvider"

const getFileProviderInfoContent = (appName: string, props: FileProviderPluginProps) => {
	return build({
		AppGroup: props.iosAppGroupIdentifier,
		CFBundleName: "$(PRODUCT_NAME)",
		CFBundleDisplayName: `${appName} - File Provider`,
		CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
		CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
		CFBundleExecutable: "$(EXECUTABLE_NAME)",
		CFBundleInfoDictionaryVersion: "6.0",
		CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
		NSExtension: {
			// NSExtensionFileProviderDocumentGroup is deliberately ABSENT, and belongs with the
			// replicated principal class below rather than being weighed on its own. Setting it
			// makes iOS create a legacy default domain; a replicated provider cannot service one,
			// so the system routes that domain's mutations into its own FPXFakeDefaultDomainExtension
			// shim, whose modifyItem: hits an assert and aborts the extension — a C assert, so the
			// FPExceptionToErrorProxy wrapping the call cannot turn it back into an error. The app
			// registers its one real domain through NSFileProviderManager instead, and while the key
			// was harmless under the pre-replicated extension (a second instance of our own class
			// served the default domain), pairing it with this principal class is what crashes.
			//
			// The cost of leaving it out is an ITMS-90360 validation WARNING on upload, which is
			// accepted: the build still processes and ships. Nothing derives from the key either —
			// the content cache spells out its app-group path literally.
			NSExtensionFileProviderSupportsEnumeration: true,
			// matches filen-ios-file-provider 99f4a72 — without this the extension is
			// greyed out in other apps' folder pickers (e.g. Cryptomator vault location)
			NSExtensionFileProviderSupportsPickingFolders: true,
			NSExtensionPointIdentifier: "com.apple.fileprovider-nonui",
			NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).FileProviderExtension"
		}
	})
}

const writeFileProviderFiles = async (
	extensionDir: string,
	projectRoot: string,
	swiftFiles: string[],
	appName: string,
	props: FileProviderPluginProps
) => {
	await fs.promises.mkdir(extensionDir, {
		recursive: true
	})

	await fs.promises.writeFile(path.join(extensionDir, `${EXTENSION_NAME}-Info.plist`), getFileProviderInfoContent(appName, props))

	await fs.promises.writeFile(
		path.join(extensionDir, `${EXTENSION_NAME}.entitlements`),
		build({
			"com.apple.security.application-groups": [props.iosAppGroupIdentifier],
			// Shared keychain access group so the extension can read the auth.json DEK the app wrote via
			// expo-secure-store.
			"keychain-access-groups": [`${props.developmentTeamId}.io.filen.sharedkeys`]
		})
	)

	await fs.promises.writeFile(
		path.join(extensionDir, "PrivacyInfo.xcprivacy"),
		build({
			NSPrivacyAccessedAPITypes: [
				{
					NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
					NSPrivacyAccessedAPITypeReasons: ["CA92.1"]
				}
			],
			NSPrivacyCollectedDataTypes: [],
			NSPrivacyTracking: false
		})
	)

	const swiftSrcDir = path.join(projectRoot, "filen-ios-file-provider", "FilenFileProviderExtension")

	for (const file of swiftFiles) {
		await fs.promises.copyFile(path.join(swiftSrcDir, file), path.join(extensionDir, file))
	}

	await fs.promises.copyFile(
		path.join(projectRoot, "filen-rs", "target", "uniffi-xcframework-staging", `${props.libName}.swift`),
		path.join(extensionDir, `${props.libName}.swift`)
	)
}

async function buildRustForIOS(projectRoot: string, props: FileProviderPluginProps) {
	const { libName, targets, cargoArgs } = props
	const fullRustPath = path.join(projectRoot, "filen-rs")

	execSync(`cargo build --lib --release ${targets.map(t => `--target ${t}`).join(" ")} -p ${props.crateName} ${cargoArgs || ""}`, {
		cwd: fullRustPath,
		stdio: "inherit"
	})

	execSync(
		`cargo run -p uniffi-bindgen-swift -- target/${targets[0]!}/release/lib${libName}.a target/uniffi-xcframework-staging --swift-sources --headers --modulemap --module-name ${libName}FFI --modulemap-filename module.modulemap`,
		{
			cwd: fullRustPath,
			stdio: "inherit"
		}
	)

	const iosTargetPath = path.join(fullRustPath, "target", "ios")

	if (fs.existsSync(iosTargetPath)) {
		await fs.promises.rm(iosTargetPath, {
			recursive: true,
			force: true
		})
	}

	execSync(
		`xcodebuild -create-xcframework ${targets
			.map(t => `-library target/${t}/release/lib${libName}.a -headers target/uniffi-xcframework-staging`)
			.join(" ")} -output target/ios/lib${libName}.xcframework`,
		{
			cwd: fullRustPath,
			stdio: "inherit"
		}
	)
}

const withFileProviderXcodeTarget: ConfigPlugin<FileProviderPluginProps> = (config, props) => {
	return withXcodeProject(config, async config => {
		const { projectRoot, platformProjectRoot } = config.modRequest
		const appIdentifier = config.ios?.bundleIdentifier
		const marketingVersion = config.version

		if (!appIdentifier || !marketingVersion) {
			throw new Error("[expo-file-provider] \"ios.bundleIdentifier\" and \"version\" must be set in app.config.ts.")
		}

		const currentProjectVersion = config.ios?.buildNumber || "1"
		const extensionDir = path.join(platformProjectRoot, EXTENSION_NAME)
		const infoPlistFilePath = path.join(extensionDir, `${EXTENSION_NAME}-Info.plist`)
		const entitlementsFilePath = path.join(extensionDir, `${EXTENSION_NAME}.entitlements`)
		const swiftFiles = (await fs.promises.readdir(path.join(projectRoot, "filen-ios-file-provider", "FilenFileProviderExtension"))).filter(
			file => file.endsWith(".swift")
		)

		await writeFileProviderFiles(extensionDir, projectRoot, swiftFiles, config.name, props)

		const pbxProject = config.modResults

		// Check if the extension target already exists. If so, abort the process since the steps below are already done.
		if (pbxProject.pbxTargetByName(EXTENSION_NAME)) {
			return config
		}

		const target = pbxProject.addTarget(EXTENSION_NAME, "app_extension", EXTENSION_NAME)

		// Add a new PBXSourcesBuildPhase for our FileProvider Swift files
		pbxProject.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target.uuid)

		// Add a new PBXResourcesBuildPhase for the Resources used by the FileProvider
		pbxProject.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid)

		// Add a new PBXFrameworksBuildPhase for the FileProvider target
		pbxProject.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid)

		// Create a separate PBXGroup for the FileProvider's files
		const pbxGroupKey = pbxProject.pbxCreateGroup(EXTENSION_NAME, EXTENSION_NAME)

		pbxProject.addFramework("UniformTypeIdentifiers.framework", {
			target: target.uuid,
			link: true,
			embed: false
		})

		// for libheic
		pbxProject.addFramework("libc++.tbd", {
			target: target.uuid,
			link: true,
			embed: false
		})

		// Add the xcframework to the FileProvider target
		const xcframeworkPath = path.join(projectRoot, "filen-rs", "target", "ios", `lib${props.libName}.xcframework`)

		pbxProject.addFramework(xcframeworkPath, {
			customFramework: true,
			embed: false,
			link: true,
			target: target.uuid
		})

		// Add files which are not part of any build phase (FileProvider-Info.plist)
		pbxProject.addFile(infoPlistFilePath, pbxGroupKey)

		// Add all Swift source files to our PbxGroup and PBXSourcesBuildPhase
		for (const file of [...swiftFiles, `${props.libName}.swift`]) {
			pbxProject.addSourceFile(
				path.join(extensionDir, file),
				{
					target: target.uuid
				},
				pbxGroupKey
			)
		}

		// Add the resource files
		try {
			// PrivacyInfo.xcprivacy
			pbxProject.addResourceFile(
				path.join(extensionDir, "PrivacyInfo.xcprivacy"),
				{
					target: target.uuid
				},
				pbxGroupKey
			)
		} catch (e) {
			if (e instanceof Error && e.message.includes("reading 'path'")) {
				console.error(e)

				throw new Error("[expo-file-provider] Could not add resource files to the FileProvider; the xcode patch under patches/ did not apply")
			}

			throw e
		}

		const configurations = pbxProject.pbxXCBuildConfigurationSection()

		for (const key in configurations) {
			if (typeof configurations[key].buildSettings !== "undefined") {
				const buildSettingsObj = configurations[key].buildSettings

				if (typeof buildSettingsObj["PRODUCT_NAME"] !== "undefined" && buildSettingsObj["PRODUCT_NAME"] === `"${EXTENSION_NAME}"`) {
					buildSettingsObj["CLANG_ENABLE_MODULES"] = "YES"
					buildSettingsObj["INFOPLIST_FILE"] = `"${infoPlistFilePath}"`
					buildSettingsObj["CODE_SIGN_ENTITLEMENTS"] = `"${entitlementsFilePath}"`
					buildSettingsObj["CODE_SIGN_STYLE"] = "Automatic"
					buildSettingsObj["CURRENT_PROJECT_VERSION"] = `"${currentProjectVersion}"`
					buildSettingsObj["GENERATE_INFOPLIST_FILE"] = "YES"
					buildSettingsObj["MARKETING_VERSION"] = `"${marketingVersion}"`
					buildSettingsObj["PRODUCT_BUNDLE_IDENTIFIER"] = `"${appIdentifier}.FileProvider"`
					buildSettingsObj["SWIFT_EMIT_LOC_STRINGS"] = "YES"
					buildSettingsObj["SWIFT_VERSION"] = "5.0"
					buildSettingsObj["TARGETED_DEVICE_FAMILY"] = "\"1,2\""
					buildSettingsObj["IPHONEOS_DEPLOYMENT_TARGET"] = "16.0"
				}

				buildSettingsObj["DEVELOPMENT_TEAM"] = `"${props.developmentTeamId}"`
				// Only arm64 targets are built, and the xcode module cannot express a simulator-only exclusion.
				buildSettingsObj["EXCLUDED_ARCHS"] = "x86_64"
			}
		}

		return config
	})
}

const withFileProvider: ConfigPlugin<FileProviderPluginProps> = (config, props) => {
	// First handle the Rust build
	config = withDangerousMod(config, [
		"ios",
		async config => {
			await buildRustForIOS(config.modRequest.projectRoot, props)

			return config
		}
	])

	// Then add the FileProvider target (which includes the framework)
	config = withFileProviderXcodeTarget(config, props)

	return config
}

export default withFileProvider
