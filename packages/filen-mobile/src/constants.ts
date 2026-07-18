import type { NetInfoConfiguration } from "@react-native-community/netinfo"
import { Platform } from "react-native"

export const IOS_APP_GROUP_IDENTIFIER: string = "group.io.filen.app"

export const FILE_PUBLIC_LINK_URL_PREFIX: string = "https://app.filen.io/#/d/"
export const DIRECTORY_PUBLIC_LINK_URL_PREFIX: string = "https://app.filen.io/#/f/"

// Pinned local HTTP-provider port (spec: docs/pip-video-player.md §5.4). Player sources are
// initial-only and URLs embed the port, so provider restarts must land on the SAME port or every
// live player breaks. Dynamic/private range (49152–65535); the start logic falls through a small
// ladder only on the session's FIRST bind, never mid-session.
export const HTTP_PROVIDER_PRIMARY_PORT = 49736

// Picture-in-Picture for the video preview (spec: docs/pip-video-player.md). Default ON
// (product call 2026-07-04); toggle lives in Advanced settings.
export const PIP_ENABLED_SECURE_STORE_KEY = "pipEnabled"
export const DEFAULT_PIP_ENABLED = true

// Tap haptic feedback (the global PressablesConfig selection haptic). Default ON; toggle lives in
// Advanced settings. Read non-reactively via lib/haptics (see there) so the root layout never
// re-renders on change.
export const HAPTICS_ENABLED_SECURE_STORE_KEY = "hapticsEnabled"
export const DEFAULT_HAPTICS_ENABLED = true

export const NETINFO_CONFIG: NetInfoConfiguration = {
	reachabilityUrl: "https://gateway.filen.io",
	reachabilityTest: async response => response.status === 200,
	reachabilityLongTimeout: 60 * 1000,
	reachabilityShortTimeout: 30 * 1000,
	reachabilityRequestTimeout: 45 * 1000,
	reachabilityShouldRun: () => true,
	shouldFetchWiFiSSID: false,
	useNativeReachability: false
}

// What expo-image-manipulator can decode into a bitmap — gates image thumbnails, camera-upload
// compression, and avatar upload. iOS loads local files via UIImage(data:), i.e. full ImageIO
// (incl. TIFF/JXL/ICO); Android goes through Glide.asBitmap() on the shared app-wide registry,
// so expo-image's bundled libavif integration makes AVIF decodable on every supported device
// (BitmapFactory covers the rest; Android has no TIFF/JXL decoder). Decoders sniff bytes — these
// lists are only the entry gate. Keep each platform's list a subset of
// EXPO_IMAGE_SUPPORTED_EXTENSIONS so nothing thumbnails without also being openable.
// Verified-working but deliberately excluded: .dng (decodes on both platforms, but this list
// also gates camera-upload compression — full-RAW developing a large DNG inside the background
// task risks an OOM kill; needs a size cap first), .cur/.heics (near-zero prevalence), .svg (no
// bitmap decode path on either platform — render-only, via react-native-svg / PreviewSvg).
export const EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [
			".jpg",
			".jpeg",
			".png",
			".gif",
			".bmp",
			".tiff",
			".tif",
			".heic",
			".heif",
			".hif",
			".webp",
			".avif",
			".jxl",
			".ico",
			".apng"
		],
		android: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif", ".hif", ".avif", ".ico", ".apng"],
		default: [".jpg", ".jpeg", ".png", ".gif", ".bmp"]
	}) as string[]
)

// What the native players actually play — gates video previews AND video thumbnails. iOS is
// AVFoundation end to end (one envelope); Android playback is Media3/ExoPlayer while thumbnails
// go through the platform MediaMetadataRetriever, so Android entries must satisfy BOTH stacks
// (.mov qualifies: the QuickTime brand is accepted by both sniffers). The gate is
// container-level; codec support inside still varies (an AV1 .mp4 needs an AV1-capable iPhone,
// exotic .mkv audio tracks like AC-3/DTS are device-dependent on Android).
// Verified-working but deliberately excluded: .qt (extinct alias of .mov).
// Never add: .ts/.mts (collide with TypeScript — this set is checked before the code-extension
// switch in getPreviewType — and Media3 can't parse 192-byte AVCHD streams anyway), .avi (the
// container opens on both platforms but the dominant real-world codecs — DivX/XviD, MJPEG —
// have no decoder), .webm/.mkv on iOS, .flv/.mpg/.wmv/.ogv (no decoders anywhere).
export const EXPO_VIDEO_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".mp4", ".mov", ".m4v", ".3gp", ".3g2"],
		android: [".mp4", ".mov", ".m4v", ".webm", ".3gp", ".3g2", ".mkv"],
		default: [".mp4", ".webm"]
	}) as string[]
)

// What the native players actually DECODE (not just open) — gates audio previews + the audio
// player. iOS is AVPlayer, which resolves formats by extension/UTI with no content sniffing, so
// spelling aliases matter (.aif/.aifc); Android is ExoPlayer (content-sniffed). Ogg is
// payload-split on iOS: Opus decodes, Vorbis does not — hence .opus without .ogg/.oga there.
// Verified-working but deliberately excluded: iOS .ac3/.ec3/.eac3 (raw Dolby bitstreams), .m4r
// (ringtone AAC), .adts (alias of .aac), .au, .w64; Android .awb (AMR-WB), .mka/.weba (Matroska
// audio).
// Never add: .ogg/.oga/.amr on iOS (all three open and then fail — no Vorbis/AMR decoder in
// AVFoundation, and AMR even reports isPlayable=true), .alac (a codec, not a container — real
// ALAC lives in .m4a/.caf and plays there), .mid (needs AVMIDIPlayer / a Media3 extension
// neither expo module ships), .aiff on Android (no extractor), .wma/.ape/.wv/.mpc/.dsf/.dff
// (no decoders).
export const EXPO_AUDIO_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [".mp3", ".m4a", ".m4b", ".aac", ".wav", ".aiff", ".aif", ".aifc", ".caf", ".flac", ".opus"],
		android: [".mp3", ".m4a", ".m4b", ".aac", ".wav", ".ogg", ".oga", ".opus", ".amr", ".3gp", ".flac"],
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

// Cap audio metadata parsing by file size. music-metadata's `parseWebStream` runs on the JS
// thread and, for large files (headerless-VBR duration scans, large embedded cover art, and
// general stream/parse overhead on Hermes), can visibly degrade JS-thread performance. Above
// this size audioCache skips parsing — the track still plays, it just falls back to its
// filename with no cached cover art / tags. 100 MiB clears virtually all normal music
// (incl. long lossless tracks) and only skips genuinely huge files (podcasts, audiobooks, mixes).
export const AUDIO_METADATA_MAX_PARSE_SIZE_BYTES = 100 * 1024 * 1024

// Cap concurrent audio metadata parses. `parseWebStream` is interleaved synchronous work on the
// single Hermes JS thread — concurrent parses can't run in parallel, they only fill the
// stream-read await gaps that the UI could otherwise use. Serializing (1) keeps those gaps free
// for the UI while metadata trickles in one track at a time; bump to 2 to trade some UI headroom
// for throughput when fetching many tracks at once.
export const AUDIO_METADATA_MAX_CONCURRENT_PARSES = 1

// What expo-image can render — gates the preview gallery and the photos tab. Both platforms
// sniff bytes (iOS: SDWebImage falls through to an ImageIO catch-all, which is why TIFF/JXL/BMP
// decode even though the expo-image docs table omits them; Android: Glide → BitmapFactory plus
// bundled libavif/APNG/SVG decoders), so entries here are the UI gate, not the decoder truth.
// .hif is HEIC bytes under the Sony/Fujifilm extension; .icns/.tiff/.tif/.jxl are iOS-only (no
// Android decoder). Keep this a superset of EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS per
// platform — raster formats missing here would thumbnail without being openable (the old
// .bmp/.tiff bug); render-only extra .icns is fine. `.svg` stays in this set so it's classified
// as an image (gallery/photos-eligible — gate with isImagePreviewType, not `=== "image"`), but
// getPreviewType returns "svg" and the gallery renders it through react-native-svg (PreviewSvg),
// NOT expo-image: on Android expo-image decodes SVG via the unmaintained androidsvg 1.4, whose
// pattern rendering can recurse into an uncatchable native OOM abort on adversarial SVGs.
// Verified-working but deliberately excluded: .dng (both platforms decode RAW, but it would
// drag RAW shots into the photos tab and a full-RAW decode is the heaviest there is — product
// call), .psd/.heics on iOS (flattened PSD preview / HEIF sequences), .cur (zero prevalence).
export const EXPO_IMAGE_SUPPORTED_EXTENSIONS = new Set<string>(
	Platform.select({
		ios: [
			".jpg",
			".jpeg",
			".png",
			".gif",
			".webp",
			".avif",
			".heic",
			".heif",
			".hif",
			".svg",
			".ico",
			".icns",
			".bmp",
			".tiff",
			".tif",
			".jxl",
			".apng"
		],
		android: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic", ".heif", ".hif", ".svg", ".ico", ".bmp", ".apng"],
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
	/^f[cd][0-9a-f]{2}:/i,
	/^fe80:/i
]
