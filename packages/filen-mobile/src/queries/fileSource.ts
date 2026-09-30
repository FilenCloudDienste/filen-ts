import * as FileSystem from "expo-file-system"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"
import { type DriveItemFileExtracted } from "@/types"
import { isFileItem } from "@/features/drive/driveSelectors"

export type FileSource =
	| {
			type: "drive"
			data: {
				uuid: string
				// Optional by-value file item. Threaded by callers that already hold the
				// DriveItem — e.g. a cross-directory cache-search result whose item is NOT in
				// the global uuid cache (it was never browsed). Preferred over the cache
				// lookup; the cache is the fallback. NEVER part of the query key — see
				// `fileSourceKey` — so the item object identity can't destabilize the key and
				// two sources for the same uuid still share one cache entry.
				item?: DriveItemFileExtracted
			}
	  }
	| {
			type: "external"
			data: {
				url: string
				name: string
			}
	  }

// Stable query key for a FileSource: identity only (uuid / url+name), with the optional
// by-value `item` stripped. A full DriveItem in the key would bloat it and make it churn on
// every item-object identity change; the byte content is identified by uuid alone.
export function fileSourceKey(source: FileSource): FileSource {
	return source.type === "drive" ? { type: "drive", data: { uuid: source.data.uuid } } : source
}

// Prefers the by-value item (a cross-directory search hit may not be in the global uuid cache) and
// falls back to the cache lookup. null when missing or not a file.
export function resolveDriveFileItem(data: Extract<FileSource, { type: "drive" }>["data"]): DriveItemFileExtracted | null {
	const item = data.item ?? cache.uuidToAnyDriveItem.get(data.uuid)

	return item && isFileItem(item) ? item : null
}

export async function resolveFile(source: FileSource, signal?: AbortSignal): Promise<FileSystem.File> {
	if (source.type === "drive") {
		const item = resolveDriveFileItem(source.data)

		if (!item) {
			throw new Error("Drive item not found or is not a file")
		}

		return await fileCache.get({
			item: {
				type: "drive",
				data: item
			},
			signal
		})
	}

	return await fileCache.get({
		item: source,
		signal
	})
}
