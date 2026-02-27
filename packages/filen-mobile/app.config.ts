import "ts-node/register"
import type { ExpoConfig, ConfigContext } from "expo/config"

const VERSION: string = "3.1.0"

const APPLE_TEAM_ID: string = "7YTW5D2K7P"
const IOS_APP_GROUP_ID: string = "group.io.filen.app"
const JS_ENGINE: "hermes" | "jsc" = "hermes"
const ANDROID_MIN_SDK_VERSION: number = 31
const ANDROID_TARGET_SDK_VERSION: number = 36
const ANDROID_COMPILE_SDK_VERSION: number = 36
const ANDROID_BUILD_TOOLS_VERSION: string = "36.0.0"
const IOS_DEPLOYMENT_TARGET: string = "18.0"
const NAME: string = "Filen"
const IDENTIFIER: string = "com.anonymous.filenmobile" // "io.filen.app"

// TODO: Add back @config-plugins/react-native-blob-util when its updated for sdk 55

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
	// icon: "./assets/images/icon.png",
	icon: "./src/assets/images/icon.png",
	scheme: "iofilenapp",
	userInterfaceStyle: "automatic",
	jsEngine: JS_ENGINE,
	platforms: ["ios", "android"],
	githubUrl: "https://github.com/FilenCloudDienste/filen-ts/packages/filen-mobile",
	ios: {
		buildNumber: BUILD_NUMBER.toString(),
		version: VERSION,
		supportsTablet: true,
		bundleIdentifier: IDENTIFIER,
		requireFullScreen: true,
		usesIcloudStorage: true,
		jsEngine: JS_ENGINE,
		appleTeamId: APPLE_TEAM_ID,
		entitlements: {
			"com.apple.security.application-groups": [IOS_APP_GROUP_ID]
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
			LSApplicationCategoryType: "public.app-category.productivity",
			UIRequiredDeviceCapabilities: ["arm64"],
			CFBundleAllowMixedLocalizations: true,
			CFBundleLocalizations: [
				"en",
				"de",
				"fr",
				"id",
				"it",
				"ja",
				"ko",
				"nl",
				"no",
				"pl",
				"pt",
				"ro",
				"ru",
				"sv",
				"th",
				"uk",
				"ur",
				"vi",
				"zh",
				"es",
				"hi",
				"hu",
				"cs",
				"da",
				"bn",
				"fi",
				"he"
			],
			CFBundleDevelopmentRegion: "en",
			UIPrefersShowingLanguageSettings: true
		},
		// icon: {
		// 	dark: "./assets/images/ios-dark.png",
		// 	light: "./assets/images/ios-light.png",
		// 	tinted: "./assets/images/ios-tinted.png"
		// },
		privacyManifests: {
			NSPrivacyTracking: false
		}
	},
	android: {
		version: VERSION,
		versionCode: BUILD_NUMBER,
		jsEngine: JS_ENGINE,
		allowBackup: false,
		adaptiveIcon: {
			backgroundColor: "#E6F4FE",
			foregroundImage: "./src/assets/images/android-icon-foreground.png",
			backgroundImage: "./src/assets/images/android-icon-background.png",
			monochromeImage: "./src/assets/images/android-icon-monochrome.png"
		},
		predictiveBackGestureEnabled: false,
		// adaptiveIcon: {
		// 	foregroundImage: "./assets/images/adaptive-icon.png",
		// 	backgroundColor: "#ffffff"
		// },
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
			"FOREGROUND_SERVICE",
			"USE_FINGERPRINT",
			"USE_BIOMETRIC",
			"SYSTEM_ALERT_WINDOW",
			"ACTION_OPEN_DOCUMENT",
			"ACTION_OPEN_DOCUMENT_TREE"
		]
	},
	plugins: [
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
					enableProguardInReleaseBuilds: false,
					enableShrinkResourcesInReleaseBuilds: false,
					enableBundleCompression: false,
					useLegacyPackaging: false,
					enablePngCrunchInReleaseBuilds: false,
					packagingOptions: {
						pickFirst: ["**/libcrypto.so"]
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
				image: "./src/assets/images/splash-icon.png",
				imageWidth: 200,
				resizeMode: "contain",
				backgroundColor: "#ffffff",
				dark: {
					backgroundColor: "#000000"
				}
			}
		],
		"expo-video",
		"expo-sqlite",
		"expo-localization",
		"expo-background-task",
		"expo-audio",
		"expo-secure-store",
		"expo-navigation-bar",
		[
			"react-native-edge-to-edge",
			{
				android: {
					parentTheme: "Default",
					enforceNavigationBarContrast: false
				}
			}
		]
	],
	experiments: {
		typedRoutes: true,
		reactCompiler: true
	}
})
