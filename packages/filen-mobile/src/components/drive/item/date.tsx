import { memo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"
import { type AnyDirWithContext } from "@filen/sdk-rs"

type Props = {
	info: ListRenderItemInfo<{
		item: DriveItem
		parent?: AnyDirWithContext
	}>
}

export const DateComponent = memo(({ info }: Props) => {
	if (info.item.item.type === "file" || info.item.item.type === "sharedFile") {
		if (info.item.item.data.decryptedMeta?.modified) {
			return simpleDate(Number(info.item.item.data.decryptedMeta.modified))
		}

		if (info.item.item.data.decryptedMeta?.created) {
			return simpleDate(Number(info.item.item.data.decryptedMeta.created))
		}

		if (info.item.item.type === "file") {
			return simpleDate(Number(info.item.item.data.timestamp))
		}

		return simpleDate(new Date().getTime())
	}

	if (info.item.item.data.decryptedMeta?.created) {
		return simpleDate(Number(info.item.item.data.decryptedMeta.created))
	}

	if (info.item.item.type === "directory") {
		return simpleDate(Number(info.item.item.data.timestamp))
	}

	return simpleDate(new Date().getTime())
})

export default DateComponent
