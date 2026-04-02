import { memo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import { simpleDate } from "@/lib/time"

const DateComponent = memo(({ info }: { info: ListRenderItemInfo<DriveItem> }) => {
	switch (info.item.type) {
		case "file": {
			if (info.item.data.decryptedMeta?.modified) {
				return simpleDate(Number(info.item.data.decryptedMeta.modified))
			}

			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.timestamp))
		}

		case "directory": {
			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.timestamp))
		}

		case "sharedFile": {
			if (info.item.data.decryptedMeta?.modified) {
				return simpleDate(Number(info.item.data.decryptedMeta.modified))
			}

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

		case "sharedRootFile": {
			if (info.item.data.decryptedMeta?.modified) {
				return simpleDate(Number(info.item.data.decryptedMeta.modified))
			}

			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.timestamp))
		}

		case "sharedRootDirectory": {
			if (info.item.data.decryptedMeta?.created) {
				return simpleDate(Number(info.item.data.decryptedMeta.created))
			}

			return simpleDate(Number(info.item.data.inner.timestamp))
		}
	}
})

export default DateComponent
