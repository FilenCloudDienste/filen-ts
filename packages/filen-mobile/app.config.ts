/* eslint-disable no-restricted-imports */

import "ts-node/register"
import type { ExpoConfig, ConfigContext } from "expo/config"
import { SUPPORTED_LANGUAGES } from "./src/locales/languages"
import { EXTERNAL_LINK_PROTOCOLS } from "./src/lib/untrustedLinks"
import { APPLE_TEAM_ID, IOS_APP_GROUP_IDENTIFIER, IOS_KEYCHAIN_ACCESS_GROUP } from "./src/lib/appIdentity"

const VERSION: string = "4.0.18"

const ANDROID_MIN_SDK_VERSION: number = 31
const ANDROID_TARGET_SDK_VERSION: number = 36
const ANDROID_COMPILE_SDK_VERSION: number = 36
const ANDROID_BUILD_TOOLS_VERSION: string = "36.0.0"
// Gradle ABIs and the Rust .so set must match. x86_64 first: withAndroidRustBuild reads targets[0] for uniffi-bindgen
const ANDROID_ABIS: string[] = ["x86_64", "arm64-v8a"]
const IOS_DEPLOYMENT_TARGET: string = "26.0"
const NAME: string = "Filen"
const IDENTIFIER: string = "io.filen.app"

// The iOS File Provider extension and the Android provider build the same crate
const NATIVE_CACHE_CRATE = {
	crateName: "filen-mobile-native-cache",
	libName: "filen_mobile_native_cache",
	cargoArgs: "-F heif-decoder"
}

// Both platforms' scheme declarations derive from the runtime allowlist so what the app will open and
// what it may ask the OS about cannot drift apart. "http://" -> "http", "tel:" -> "tel".
const EXTERNAL_LINK_SCHEMES: string[] = EXTERNAL_LINK_PROTOCOLS.map(protocol => protocol.replace(/:.*$/, ""))

// Several plugins write the same Info.plist keys; the last one wins, so they must share one string.
const CAMERA_USAGE: string = "Please allow access to your camera so that Filen can take photos."
const MICROPHONE_USAGE: string = "Please allow access to your microphone so that Filen can capture audio when recording videos."

function semverToNumber(version: string): number {
	const parts = version.replace(/^v/, "").split(".").map(Number)

	while (parts.length < 3) {
		parts.push(0)
	}

	const [major, minor, patch] = parts

	if (
		typeof major !== "number" ||
		typeof minor !== "number" ||
		typeof patch !== "number" ||
		parts.some(part => isNaN(part) || part < 0 || part > 999)
	) {
		throw new Error(`Invalid semver format: ${version}`)
	}

	return major * 1000000 + minor * 1000 + patch
}

const BUILD_NUMBER: number = semverToNumber(VERSION)

export default ({ config }: ConfigContext): ExpoConfig => ({
	...config,
	name: NAME,
	slug: "filen-mobile",
	version: VERSION,
	orientation: "default",
	icon: "./src/assets/images/icon-light.png",
	scheme: "iofilenapp",
	userInterfaceStyle: "automatic",
	platforms: ["ios", "android"],
	githubUrl: "https://github.com/FilenCloudDienste/filen-ts/packages/filen-mobile",
	ios: {
		buildNumber: BUILD_NUMBER.toString(),
		version: VERSION,
		supportsTablet: true,
		bundleIdentifier: IDENTIFIER,
		requireFullScreen: true,
		usesIcloudStorage: true,
		appleTeamId: APPLE_TEAM_ID,
		// Password AutoFill: associates the app with credentials saved for the Filen web
		// domains so iOS and third-party password managers offer them on the login screen.
		// Each listed domain must serve
		// https://<domain>/.well-known/apple-app-site-association with
		// "webcredentials": { "apps": ["<team>.<bundle>"] }. The Associated Domains App ID
		// capability is enabled automatically by CI's cloud signing (-allowProvisioningUpdates).
		associatedDomains: ["webcredentials:filen.io", "webcredentials:drive.filen.io", "webcredentials:app.filen.io"],
		entitlements: {
			"com.apple.security.application-groups": [IOS_APP_GROUP_IDENTIFIER],
			// Dedicated team-prefixed keychain access group shared with the File Provider extension so
			// both can read the auth.json DEK. On iOS the app group alone does NOT grant keychain sharing;
			// a keychain-access-groups entry is required on both the app and the extension.
			"keychain-access-groups": [IOS_KEYCHAIN_ACCESS_GROUP]
		},
		config: {
			usesNonExemptEncryption: false
		},
		infoPlist: {
			UIFileSharingEnabled: true,
			LSSupportsOpeningDocumentsInPlace: true,
			UIBackgroundModes: ["audio", "fetch", "processing"],
			NSAppTransportSecurity: {
				NSAllowsLocalNetworking: true,
				NSAllowsArbitraryLoads: false
			},
			// iOS refuses canOpenURL for any scheme not declared here, so without it every mailto:/tel:/
			// sms: link in the app fails the can-open check and reports "cannot open" — previews, notes
			// and chat alike. http/https are handled by the system and must not be listed.
			LSApplicationQueriesSchemes: EXTERNAL_LINK_SCHEMES.filter(scheme => scheme !== "http" && scheme !== "https"),
			LSApplicationCategoryType: "public.app-category.productivity",
			UIRequiredDeviceCapabilities: ["arm64"],
			CFBundleAllowMixedLocalizations: true,
			CFBundleLocalizations: [...SUPPORTED_LANGUAGES],
			CFBundleDevelopmentRegion: "en",
			UIPrefersShowingLanguageSettings: true
		},
		icon: "./src/assets/images/ios.icon",
		privacyManifests: {
			NSPrivacyTracking: false
		}
	},
	android: {
		version: VERSION,
		versionCode: BUILD_NUMBER,
		allowBackup: false,
		adaptiveIcon: {
			backgroundColor: "#FFFFFF",
			foregroundImage: "./src/assets/images/adaptive-foreground.png",
			monochromeImage: "./src/assets/images/adaptive-monochrome.png"
		},
		predictiveBackGestureEnabled: false,
		package: IDENTIFIER,
		permissions: [
			"INTERNET",
			"ACCESS_NETWORK_STATE",
			"ACCESS_WIFI_STATE",
			"READ_EXTERNAL_STORAGE",
			"WRITE_EXTERNAL_STORAGE",
			"CAMERA",
			"RECORD_AUDIO",
			"READ_MEDIA_IMAGES",
			"READ_MEDIA_VIDEO",
			"READ_MEDIA_AUDIO",
			"ACCESS_MEDIA_LOCATION",
			"WAKE_LOCK",
			"RECEIVE_BOOT_COMPLETED",
			"VIBRATE",
			"POST_NOTIFICATIONS",
			"USE_FINGERPRINT",
			"USE_BIOMETRIC",
			"SYSTEM_ALERT_WINDOW",
			"MANAGE_DOCUMENTS"
		]
	},
	plugins: [
		[
			"expo-plugin-ios-static-libraries",
			{
				libraries: ["op-sqlite"]
			}
		],
		// The engine is passed explicitly. A bare plugin entry does NOT pin it — the plugin falls back
		// to ITS OWN default, and this repo regenerates native projects with `prebuild --clean`, so a
		// future release that flipped that default would silently move camera upload's dedup hashing
		// onto a different native implementation with no diff here.
		[
			"@preeternal/react-native-file-hash",
			{
				engine: "native"
			}
		],
		[
			"expo-build-properties",
			{
				buildReactNativeFromSource: true,
				useHermesV1: true,
				android: {
					compileSdkVersion: ANDROID_COMPILE_SDK_VERSION,
					targetSdkVersion: ANDROID_TARGET_SDK_VERSION,
					minSdkVersion: ANDROID_MIN_SDK_VERSION,
					buildToolsVersion: ANDROID_BUILD_TOOLS_VERSION,
					buildArchs: ANDROID_ABIS,
					enableProguardInReleaseBuilds: false,
					enableShrinkResourcesInReleaseBuilds: false,
					enableBundleCompression: false,
					useLegacyPackaging: false,
					enablePngCrunchInReleaseBuilds: false,
					// Android 11+ package visibility hides handlers for undeclared schemes from
					// Linking.canOpenURL, so a mailto:/tel: link reports "cannot open" even with a handler
					// installed. No <category>: a category-less query matches CATEGORY_DEFAULT, which every
					// launchable activity declares. https is omitted because the template already declares it.
					manifestQueries: {
						intent: EXTERNAL_LINK_SCHEMES.filter(scheme => scheme !== "https").map(scheme => ({
							action: "VIEW",
							data: { scheme }
						}))
					}
				},
				ios: {
					deploymentTarget: IOS_DEPLOYMENT_TARGET,
					useFrameworks: "static"
				}
			}
		],
		[
			"expo-router",
			{
				root: "./src/routes"
			}
		],
		[
			"expo-splash-screen",
			{
				image: "./src/assets/images/icon-light.png",
				imageWidth: 200,
				resizeMode: "contain",
				backgroundColor: "#FFFFFF",
				dark: {
					image: "./src/assets/images/icon-dark.png",
					backgroundColor: "#000000"
				}
			}
		],
		[
			"expo-video",
			{
				// PiP for the video preview (spec: docs/pip-video-player.md). Sets
				// android:supportsPictureInPicture on MainActivity (hard requirement) and manages
				// the iOS `audio` UIBackgroundMode (already present via UIBackgroundModes above).
				supportsPictureInPicture: true
			}
		],
		[
			"expo-audio",
			{
				microphonePermission: MICROPHONE_USAGE,
				enableBackgroundPlayback: true,
				enableBackgroundRecording: false,
				recordAudioAndroid: false
			}
		],
		[
			"expo-media-library",
			{
				photosPermission: "Please allow access to your camera so that Filen can upload photos you take inside the app.",
				savePhotosPermission: "Please allow access to your photo library so that Filen can save photos on your device.",
				isAccessMediaLocationEnabled: true
			}
		],
		[
			"expo-document-picker",
			{
				iCloudContainerEnvironment: "Production"
			}
		],
		[
			"expo-image-picker",
			{
				photosPermission: "Please allow access to your photos so that Filen can back them up automatically.",
				cameraPermission: CAMERA_USAGE,
				microphonePermission: MICROPHONE_USAGE
			}
		],
		[
			"expo-local-authentication",
			{
				faceIDPermission: "Please allow Filen to use FaceID or TouchID to lock itself."
			}
		],
		"@config-plugins/react-native-blob-util",
		"expo-localization",
		"expo-background-task",
		"expo-secure-store",
		"expo-navigation-bar",
		"expo-asset",
		"expo-font",
		[
			"expo-sharing",
			{
				ios: {
					enabled: true,
					appGroupId: IOS_APP_GROUP_IDENTIFIER,
					activationRule: {
						supportsFileWithMaxCount: 100,
						supportsImageWithMaxCount: 100,
						supportsMovieWithMaxCount: 100,
						supportsText: false,
						supportsWebUrlWithMaxCount: 0,
						supportsWebPageWithMaxCount: 0,
						supportsAttachmentsWithMaxCount: 0
					}
				},
				android: {
					enabled: true,
					singleShareMimeTypes: ["*/*"],
					multipleShareMimeTypes: ["*/*"]
				}
			}
		],
		"expo-image",
		[
			"react-native-edge-to-edge",
			{
				android: {
					parentTheme: "Default",
					enforceNavigationBarContrast: false
				}
			}
		],
		"./plugins/withAndroidNetworkSecurityConfig",
		"./plugins/withAndroidApplicationAttributes",
		// Debug builds install as io.filen.app.debug so a dev build and the Play-Store app can
		// coexist on one device — release builds are untouched.
		"./plugins/withAndroidDebugSuffix",
		"./plugins/withGradleMemory",
		// Also adds the FOREGROUND_SERVICE and FOREGROUND_SERVICE_DATA_SYNC permissions.
		[
			"react-native-notify-kit",
			{
				android: {
					foregroundService: {
						types: ["dataSync"]
					}
				}
			}
		],
		[
			"./plugins/withAndroidLocaleConfig",
			{
				locales: [...SUPPORTED_LANGUAGES]
			}
		],
		[
			"./plugins/withFileProvider",
			{
				...NATIVE_CACHE_CRATE,
				targets: ["aarch64-apple-ios", "aarch64-apple-ios-sim"],
				developmentTeamId: APPLE_TEAM_ID,
				iosAppGroupIdentifier: IOS_APP_GROUP_IDENTIFIER
			}
		],
		[
			"./plugins/withAndroidRustBuild",
			{
				...NATIVE_CACHE_CRATE,
				targets: ANDROID_ABIS
			}
		],
		"./plugins/withAndroidSigning",
		[
			"react-native-document-scanner-plugin",
			{
				cameraPermission: CAMERA_USAGE
			}
		]
	],
	experiments: {
		typedRoutes: true,
		reactCompiler: true
	}
})
