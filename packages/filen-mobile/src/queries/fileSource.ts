import * as FileSystem from "expo-file-system"
import cache from "@/lib/cache"
import fileCache from "@/lib/fileCache"

export type FileSource =
	| {
			type: "drive"
			data: {
				uuid: string
			}
	  }
	| {
			type: "external"
			data: {
				url: string
				name: string
			}
	  }

export async function resolveFile(source: FileSource, signal?: AbortSignal): Promise<FileSystem.File> {
	if (source.type === "drive") {
		const item = cache.uuidToAnyDriveItem.get(source.data.uuid)

		if (!item || (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")) {
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
