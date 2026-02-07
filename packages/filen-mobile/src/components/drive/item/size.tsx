import { memo } from "@/lib/memo"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import useDirectorySizeQuery from "@/queries/useDirectorySize.query"
import { formatBytes } from "@filen/utils"
import { type AnyDirEnumWithShareInfo } from "@filen/sdk-rs"
import type { DriveItemMenuOrigin } from "@/components/drive/item/menu"

export const Size = memo(
	({
		info,
		origin
	}: {
		info: ListRenderItemInfo<{
			item: DriveItem
			parent?: AnyDirEnumWithShareInfo
		}>
		origin: DriveItemMenuOrigin
	}) => {
		const directorySizeQuery = useDirectorySizeQuery(
			{
				uuid: info.item.item.data.uuid,
				offline: origin === "offline"
			},
			{
				enabled: info.item.item.type === "directory"
			}
		)

		if (info.item.item.type === "file" || info.item.item.type === "sharedFile") {
			return formatBytes(Number(info.item.item.data.size))
		}

		if (directorySizeQuery.status !== "success") {
			return null
		}

		return formatBytes(Number(directorySizeQuery.data))
	},
	{
		propsAreEqual(prevProps, nextProps) {
			return (
				prevProps.info.item.item.data.uuid === nextProps.info.item.item.data.uuid &&
				prevProps.info.item.item.type === nextProps.info.item.item.type
			)
		}
	}
)

export default Size
