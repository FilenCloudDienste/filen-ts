import { memo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import useDirectorySizeQuery from "@/queries/useDirectorySize.query"
import { formatBytes } from "@filen/utils"
import { type AnyDirWithContext } from "@filen/sdk-rs"
import type { DriveItemMenuOrigin } from "@/components/drive/item/menu"

type Props = {
	info: ListRenderItemInfo<{
		item: DriveItem
		parent?: AnyDirWithContext
	}>
	origin: DriveItemMenuOrigin
}

const Size = memo(({ info, origin }: Props) => {
	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: info.item.item.data.uuid,
			type:
				origin === "sharedIn"
					? "sharedIn"
					: origin === "sharedOut"
						? "sharedOut"
						: origin === "trash"
							? "trash"
							: origin === "offline"
								? "offline"
								: "normal"
		},
		{
			enabled:
				info.item.item.type === "directory" ||
				info.item.item.type === "sharedDirectory" ||
				info.item.item.type === "sharedRootDirectory"
		}
	)

	if (info.item.item.type === "file" || info.item.item.type === "sharedFile") {
		return ` • ${formatBytes(Number(info.item.item.data.size))}`
	}

	if (directorySizeQuery.status !== "success") {
		return null
	}

	return ` • ${formatBytes(directorySizeQuery.data.size)}`
})

export default Size
