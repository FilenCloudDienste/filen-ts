import type { NetInfoConfiguration } from "@react-native-community/netinfo"
import { Platform } from "react-native"

export const IOS_APP_GROUP_IDENTIFIER: string = "group.io.filen.app"

export const NETINFO_CONFIG: NetInfoConfiguration = {
	reachabilityUrl: "https://gateway.filen.io",
	reachabilityTest: async response => response.status === 200,
	reachabilityLongTimeout: 60 * 1000,
	reachabilityShortTimeout: 30 * 1000,
	reachabilityRequestTimeout: 45 * 1000,
	reachabilityShouldRun: () => true,
	shouldFetchWiFiSSID: false,
	useNativeReachability: true,
	reachabilityMethod: "HEAD"
}

export const EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS = Platform.select({
	ios: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".heic", ".heif", ".webp"],
	android: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif"],
	default: [".jpg", ".jpeg", ".png", ".gif", ".bmp"]
}) as string[]

export const EXPO_VIDEO_SUPPORTED_EXTENSIONS = Platform.select({
	ios: [".mp4", ".mov", ".m4v", ".3gp"],
	android: [".mp4", ".webm", ".3gp", ".mkv"],
	default: [".mp4", ".webm"]
}) as string[]

export const EXPO_AUDIO_SUPPORTED_EXTENSIONS = Platform.select({
	ios: [".mp3", ".m4a", ".aac", ".wav", ".aiff", ".caf", ".flac", ".alac"],
	android: [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".3gp", ".flac"],
	default: [".mp3", ".m4a", ".aac", ".wav", ".ogg"]
}) as string[]

export const EXPO_VIDEO_THUMBNAILS_SUPPORTED_EXTENSIONS = Platform.select({
	ios: [".mp4", ".mov", ".m4v", ".3gp"],
	android: [".mp4", ".webm", ".3gp", ".mkv"],
	default: [".mp4", ".webm"]
}) as string[]

export const EXPO_IMAGE_SUPPORTED_EXTENSIONS = Platform.select({
	ios: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".svg", ".ico", ".icns"],
	android: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".svg", ".ico", ".icns"],
	default: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".ico", ".icns"]
}) as string[]
