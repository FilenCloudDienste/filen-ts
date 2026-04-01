import { memo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"

type Props = {
	info: ListRenderItemInfo<DriveItem>
}

export const DateComponent = memo(({ info }: Props) => {
	if (info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile") {
		if (info.item.data.decryptedMeta?.modified) {
			return simpleDate(Number(info.item.data.decryptedMeta.modified))
		}

		if (info.item.data.decryptedMeta?.created) {
			return simpleDate(Number(info.item.data.decryptedMeta.created))
		}

		if (info.item.type === "file") {
			return simpleDate(Number(info.item.data.timestamp))
		}

		return simpleDate(new Date().getTime())
	}

	if (info.item.data.decryptedMeta?.created) {
		return simpleDate(Number(info.item.data.decryptedMeta.created))
	}

	if (info.item.type === "directory") {
		return simpleDate(Number(info.item.data.timestamp))
	}

	return simpleDate(new Date().getTime())
})

export default DateComponent
