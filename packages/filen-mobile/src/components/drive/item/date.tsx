import { memo } from "@/lib/memo"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"
import isEqual from "react-fast-compare"
import { type AnyDirWithContext } from "@filen/sdk-rs"

export const DateComponent = memo(
	({
		info
	}: {
		info: ListRenderItemInfo<{
			item: DriveItem
			parent?: AnyDirWithContext
		}>
	}) => {
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
	},
	{
		propsAreEqual(prevProps, nextProps) {
			return (
				prevProps.info.item.item.type === nextProps.info.item.item.type &&
				isEqual(prevProps.info.item.item.data, nextProps.info.item.item.data)
			)
		}
	}
)

export default DateComponent
