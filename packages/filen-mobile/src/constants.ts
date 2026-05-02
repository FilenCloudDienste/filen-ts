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

export const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi
export const TRAILING_PUNCT = /[.,;:!?'"]+$/
export const PRIVATE_HOST = [
	/^localhost$/i,
	/\.local$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^169\.254\./,
	/^0\.0\.0\.0$/,
	/^::1$/,
	/^fc00:/i,
	/^fe80:/i
]
