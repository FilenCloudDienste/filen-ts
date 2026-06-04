import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"

// File-variant date resolution is identical across file / sharedFile /
// sharedRootFile: prefer modified, then created, then the upload timestamp.
function resolveFileDate(
	item: Extract<DriveItem, { type: "file" | "sharedFile" | "sharedRootFile" }>
): string {
	if (item.data.decryptedMeta?.modified) {
		return simpleDate(Number(item.data.decryptedMeta.modified))
	}

	if (item.data.decryptedMeta?.created) {
		return simpleDate(Number(item.data.decryptedMeta.created))
	}

	return simpleDate(Number(item.data.timestamp))
}

const DateComponent = ({ info }: { info: ListRenderItemInfo<DriveItem> }) => {
	switch (info.item.type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			return resolveFileDate(info.item)
		}

		case "directory": {
			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.timestamp))
		}

		case "sharedDirectory": {
			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.inner.timestamp))
		}

		case "sharedRootDirectory": {
			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.inner.timestamp))
		}
	}
}

export default DateComponent
