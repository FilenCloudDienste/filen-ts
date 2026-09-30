import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"
import { isFileItem } from "@/features/drive/driveSelectors"
import { pickDisplayTimestamp, rawUploadTimestamp } from "@/features/drive/utils"

// Files prefer modified, then created; directories created; both fall back to the upload timestamp.
const DateComponent = ({ info }: { info: ListRenderItemInfo<DriveItem> }) => {
	const item = info.item
	const metaTimestamp = isFileItem(item)
		? item.data.decryptedMeta?.modified || item.data.decryptedMeta?.created
		: item.data.decryptedMeta?.created

	return simpleDate(pickDisplayTimestamp(metaTimestamp, rawUploadTimestamp(item)))
}

export default DateComponent
