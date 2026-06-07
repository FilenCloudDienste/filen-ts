export const IOS_APP_GROUP_IDENTIFIER = "group.io.filen.app"
export const EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"])
export const EXPO_VIDEO_SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv"])
export const MUSIC_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac", ".wma", ".opus"])
export const MUSIC_METADATA_SUPPORTED_EXTENSIONS = new Set([".mp3", ".m4a", ".flac", ".ogg", ".wav", ".aac", ".opus"])
// Small cap so size-gate tests can exceed it with tiny fixtures (real value is 100 MiB).
export const AUDIO_METADATA_MAX_PARSE_SIZE_BYTES = 1024
export const AUDIO_METADATA_MAX_CONCURRENT_PARSES = 1
