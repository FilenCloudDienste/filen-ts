import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"

// Single source of truth for on-disk storage roots used by offline/fileCache/
// audioCache/thumbnails/sqlite and consumed by fsUtils. Lives in its own file
// so that fsUtils can read the Directory objects without dragging the heavy
// modules (and their native deps — expo-image, expo-video, etc.) into the
// early bundle-init chain.
//
// Each VERSION constant invalidates that storage area on disk format changes —
// bump it when changing the on-disk layout, index format, or anything else that
// makes old data incompatible with new code.

const BASE_DIRECTORY_URI = Platform.select({
	ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
	default: FileSystem.Paths.document
})

export const OFFLINE_VERSION = 1
export const OFFLINE_DIRECTORY = new FileSystem.Directory(FileSystem.Paths.join(BASE_DIRECTORY_URI, "offline", `v${OFFLINE_VERSION}`))
export const OFFLINE_FILES_DIRECTORY = new FileSystem.Directory(FileSystem.Paths.join(OFFLINE_DIRECTORY.uri, "files"))
export const OFFLINE_DIRECTORIES_DIRECTORY = new FileSystem.Directory(FileSystem.Paths.join(OFFLINE_DIRECTORY.uri, "directories"))
export const OFFLINE_INDEX_FILE = new FileSystem.File(FileSystem.Paths.join(OFFLINE_DIRECTORY.uri, "index"))

export const FILE_CACHE_VERSION = 1
export const FILE_CACHE_PARENT_DIRECTORY = new FileSystem.Directory(
	FileSystem.Paths.join(BASE_DIRECTORY_URI, "fileCache", `v${FILE_CACHE_VERSION}`)
)

export const AUDIO_CACHE_VERSION = 1
export const AUDIO_CACHE_PARENT_DIRECTORY = new FileSystem.Directory(
	FileSystem.Paths.join(BASE_DIRECTORY_URI, "audioCache", `v${AUDIO_CACHE_VERSION}`)
)

export const THUMBNAILS_VERSION = 2
export const THUMBNAILS_DIRECTORY = new FileSystem.Directory(
	FileSystem.Paths.join(BASE_DIRECTORY_URI, "thumbnails", `v${THUMBNAILS_VERSION}`)
)

export const SQLITE_VERSION = 1
export const SQLITE_DB_FILE_NAME = "sqlite.db"
export const SQLITE_DB_FILE_DIRECTORY = new FileSystem.Directory(
	FileSystem.Paths.join(BASE_DIRECTORY_URI, "sqlite", `v${SQLITE_VERSION}`)
)
