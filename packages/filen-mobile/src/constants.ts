import type { NetInfoConfiguration } from "@react-native-community/netinfo"
import { Platform } from "react-native"

export const IOS_APP_GROUP_IDENTIFIER: string = "group.io.filen.app"

export const FILE_PUBLIC_LINK_URL_PREFIX: string = "https://app.filen.io/#/d/"
export const DIRECTORY_PUBLIC_LINK_URL_PREFIX: string = "https://app.filen.io/#/f/"

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

export const EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".heic", ".heif", ".webp", ".avif"],
		android: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif"],
		default: [".jpg", ".jpeg", ".png", ".gif", ".bmp"]
	}) as string[]
)

export const EXPO_VIDEO_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".mp4", ".mov", ".m4v", ".3gp"],
		android: [".mp4", ".m4v", ".webm", ".3gp", ".mkv"],
		default: [".mp4", ".webm"]
	}) as string[]
)

export const EXPO_AUDIO_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".mp3", ".m4a", ".aac", ".wav", ".aiff", ".caf", ".flac", ".alac"],
		android: [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".3gp", ".flac"],
		default: [".mp3", ".m4a", ".aac", ".wav", ".ogg"]
	}) as string[]
)

export const EXPO_VIDEO_THUMBNAILS_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".mp4", ".mov", ".m4v", ".3gp"],
		android: [".mp4", ".m4v", ".webm", ".3gp", ".mkv"],
		default: [".mp4", ".webm"]
	}) as string[]
)

export const MUSIC_METADATA_SUPPORTED_EXTENSIONS = new Set<string>([
	".mp3",
	".mp2",
	".aac",
	".ogg",
	".opus",
	".spx",
	".flac",
	".wav",
	".aiff",
	".aif",
	".afc",
	".wv",
	".ape",
	".bwf",
	".mp4",
	".m4a",
	".m4v",
	".mka",
	".mkv",
	".webm",
	".asf",
	".wma",
	".wmv",
	".dsdiff",
	".dff",
	".dsf",
	".mpc",
	".ogv"
])

export const EXPO_IMAGE_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".svg", ".ico", ".icns"],
		android: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".svg", ".ico"],
		default: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".ico"]
	}) as string[]
)
