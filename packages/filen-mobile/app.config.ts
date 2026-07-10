/* eslint-disable import/no-unresolved */
/* eslint-disable no-restricted-imports */

import "ts-node/register"
import type { ExpoConfig, ConfigContext } from "expo/config"
import withOPSQLiteAppGroup from "./plugins/withOpSqliteAppGroup"
import { SUPPORTED_LANGUAGES } from "./src/locales/languages"

const VERSION: string = "4.0.6"

const APPLE_TEAM_ID: string = "7YTW5D2K7P"
const IOS_APP_GROUP_ID: string = "group.io.filen.app"
const ANDROID_MIN_SDK_VERSION: number = 31
const ANDROID_TARGET_SDK_VERSION: number = 36
const ANDROID_COMPILE_SDK_VERSION: number = 36
const ANDROID_BUILD_TOOLS_VERSION: string = "36.0.0"
const IOS_DEPLOYMENT_TARGET: string = "26.0"
const NAME: string = "Filen"
const IDENTIFIER: string = "io.filen.app"

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
			"FOREGROUND_SERVICE",
			"FOREGROUND_SERVICE_DATA_SYNC",
			"USE_FINGERPRINT",
			"USE_BIOMETRIC",
			"SYSTEM_ALERT_WINDOW",
			"ACTION_OPEN_DOCUMENT",
			"ACTION_OPEN_DOCUMENT_TREE",
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
				microphonePermission: "Please allow access to your microphone so that Filen can capture audio when recording videos.",
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
				cameraPermission: "Please allow access to your camera so that Filen can take photos.",
				microphonePermission: "Please allow access to your microphone so that Filen can capture audio when recording videos."
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
					appGroupId: IOS_APP_GROUP_ID,
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
		[
			withOPSQLiteAppGroup as unknown as string,
			{
				appGroupId: IOS_APP_GROUP_ID
			}
		],
		"./plugins/withAndroidNetworkSecurityConfig",
		"./plugins/withAndroidLargeHeapAndHardwareAcceleration",
		"./plugins/withGradleMemory",
		"./plugins/withNotifeeForegroundServiceType",
		[
			"./plugins/withAndroidLocaleConfig",
			{
				locales: [...SUPPORTED_LANGUAGES]
			}
		],
		[
			"./plugins/withAndroidArchitectures",
			{
				architectures: "arm64-v8a,x86_64"
			}
		],
		[
			"./plugins/withFileProvider",
			{
				crateName: "filen-mobile-native-cache",
				libName: "filen_mobile_native_cache",
				targets: ["aarch64-apple-ios", "aarch64-apple-ios-sim"],
				cargoArgs: "-F heif-decoder",
				developmentTeamId: APPLE_TEAM_ID,
				iosAppGroupIdentifier: IOS_APP_GROUP_ID
			}
		],
		[
			"./plugins/withAndroidRustBuild",
			{
				crateName: "filen-mobile-native-cache",
				libName: "filen_mobile_native_cache",
				targets: ["x86_64", "arm64-v8a"],
				cargoArgs: "-F heif-decoder"
			}
		],
		"./plugins/withAndroidSigning",
		[
			"react-native-document-scanner-plugin",
			{
				cameraPermission: "Please allow access to your camera so that Filen can take photos."
			}
		]
	],
	experiments: {
		typedRoutes: true,
		reactCompiler: true
	}
})
