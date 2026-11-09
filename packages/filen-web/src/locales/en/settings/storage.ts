// "settings" namespace — Settings > Storage — the local caches page. Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsStorage = {
	/** Settings sidebar — Storage section nav label and that section's page heading (the page lists local caches) */
	settingsSectionStorage: "Storage",
	/** Storage page — label above the usage bar in a web browser; the figure beside it is everything this site stores in the browser */
	storageTotalBrowser: "Used by Filen in this browser",
	/** Storage page — label above the usage bar in the desktop app; the figure beside it is everything the app stores on the computer */
	storageTotalDevice: "Used by Filen on this device",
	/** Storage page — accessible name of the stacked usage bar; its legend lists each part with its size */
	storageBarLabel: "Storage by cache",
	/** Storage page — legend entry for the part of the total no cache row accounts for (the local database, leftovers) */
	storageOther: "Other",
	/** Storage page — shown in place of a size that could not be measured */
	storageSizeUnknown: "—",
	/** Storage page — tooltip and accessible text for a size that could not be measured */
	storageSizeUnknownHint: "Couldn't be measured",
	/** Storage page — group title over the cache rows */
	storageGroupCaches: "Caches",
	/** Storage page — description under the caches group title */
	storageGroupCachesDescription:
		"Copies kept on this device so the app opens and scrolls faster. Clearing them never deletes your files; anything needed is downloaded again.",
	/** Storage page — Thumbnails row title */
	storageThumbnails: "Thumbnails",
	/** Storage page — Thumbnails row description */
	storageThumbnailsDescription: "Previews of images and videos, and audio covers",
	/** Storage page — Videos row title (the Videos section's library) */
	storageVideos: "Videos library",
	/** Storage page — Videos row description */
	storageVideosDescription: "Artwork, the library index and video details",
	/** Storage page — Music row title */
	storageMusic: "Music metadata",
	/** Storage page — Music row description */
	storageMusicDescription: "Titles, artists and albums read from your audio files",
	/** Storage page — row title for the saved copy of lists and content the app shows at start */
	storageQueryCache: "Cached lists and content",
	/** Storage page — description of the cached lists and content row */
	storageQueryCacheDescription: "Directory listings, notes, chats and other content kept for a fast start",
	/** Storage page — row title for the assistant's downloaded language model */
	storageModel: "AI model",
	/** Storage page — description of the AI model row; the model is shared by every account on this device */
	storageModelDescription: "The assistant's language model, shared by every account on this device",
	/** Storage page — desktop app only: row title for the app window's web cache */
	storageBrowserCache: "Browser cache",
	/** Storage page — description of the browser cache row */
	storageBrowserCacheDescription: "Web resources and compiled code the app window keeps",
	/** Storage page — desktop app only: row title for the network drive's file cache */
	storageNetworkDrive: "Network drive cache",
	/** Storage page — description of the network drive cache row */
	storageNetworkDriveDescription: "Files the network drive keeps on this device",
	/** Storage page — button that clears one cache row */
	storageClear: "Clear",
	/** Storage page — button that deletes the downloaded AI model */
	storageRemove: "Remove",
	/** Storage page — button under the rows that clears every cache except the AI model */
	storageClearAll: "Clear all caches",
	/** Storage page — confirm dialog title before clearing one cache; {{name}} is the row title */
	storageClearTitle: "Clear {{name}}?",
	/** Storage page — confirm dialog body for Thumbnails */
	storageThumbnailsBody: "Thumbnails and audio covers are downloaded and made again the next time they are shown.",
	/** Storage page — confirm dialog body for the Videos library: every open tab reloads, then the library is rebuilt */
	storageVideosBody:
		"Every open Filen tab reloads. Your video library is then indexed again, which reads its directories and parts of your videos, and artwork is made again. Watch progress is kept.",
	/** Storage page — confirm dialog body for Music metadata */
	storageMusicBody: "Track details are read from your audio files again the next time they are shown.",
	/** Storage page — confirm dialog body for cached lists and content: every open tab reloads and refetches */
	storageQueryCacheBody: "Every open Filen tab reloads, and lists and content are downloaded again as you open them.",
	/** Storage page — confirm dialog body for the desktop browser cache */
	storageBrowserCacheBody: "Web resources are fetched again when the app needs them.",
	/** Storage page — confirm dialog body for the network drive cache: the drive unmounts briefly */
	storageNetworkDriveBody:
		"The network drive is unmounted briefly while its cache is cleared. This isn't possible while files are still uploading.",
	/** Storage page — confirm dialog title before deleting the AI model */
	storageModelTitle: "Remove the AI model?",
	/** Storage page — confirm dialog body before deleting the AI model; {{size}} is its size, e.g. "2.1 GB" */
	storageModelBody: "The assistant has to download it again ({{size}}) before you can use it.",
	/** Storage page — confirm dialog title before clearing every cache */
	storageClearAllTitle: "Clear all caches?",
	/** Storage page — confirm dialog body for Clear all; {{list}} is a list of the cache row titles, e.g. "Thumbnails, Videos library and Music metadata" */
	storageClearAllBody:
		"This clears {{list}}. Every open Filen tab reloads, and anything needed is downloaded again. The AI model, your settings and your history are kept.",
	/** Storage page — added to a clear dialog when this tab is busy (a transfer, unsaved edits): it won't reload by itself */
	storageBusyNote: "Something in this tab is still running, so it asks before it reloads.",
	/** Toast after one cache was cleared; {{name}} is the row title */
	storageCleared: "{{name}} cleared",
	/** Toast when clearing one cache did not work; {{name}} is the row title */
	storageClearError: "Couldn't clear {{name}}",
	/** Toast after the AI model was deleted */
	storageModelRemoved: "AI model removed",
	/** Toast when deleting the AI model did not work, most often because another tab is using it */
	storageModelRemoveError: "Couldn't remove the AI model. If the assistant is open in another tab, close it there and try again.",
	/** Toast after Clear all succeeded for every cache */
	storageClearAllSuccess: "Caches cleared",
	/** Toast after Clear all when some caches could not be cleared; {{list}} lists their row titles */
	storageClearAllSomeError: "Couldn't clear {{list}}",
	/** Toast when the network drive cache was left alone because files are still uploading */
	storageNetworkDriveSkipped: "Network drive cache not cleared: files are still uploading",
	/** Toast in the tab that cleared caches when it is busy and will not reload by itself; paired with a Reload button */
	storageReloadThisTab: "Caches cleared. Reload to finish.",
	/** Toast in another open tab after caches were cleared elsewhere, when it is busy; paired with a Reload button */
	storageReloadOtherTab: "Caches were cleared in another tab. Reload this tab to finish."
} as const
