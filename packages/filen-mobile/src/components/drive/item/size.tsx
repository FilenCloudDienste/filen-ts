import { memo } from "react"
import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import useDirectorySizeQuery from "@/queries/useDirectorySize.query"
import { formatBytes } from "@filen/utils"
import type { DrivePath } from "@/hooks/useDrivePath"

const Size = memo(({ info, drivePath }: { info: ListRenderItemInfo<DriveItem>; drivePath: DrivePath }) => {
	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: info.item.data.uuid,
			type:
				drivePath.type === "sharedIn"
					? "sharedIn"
					: drivePath.type === "sharedOut"
						? "sharedOut"
						: drivePath.type === "trash"
							? "trash"
							: drivePath.type === "offline"
								? "offline"
								: drivePath.type === "linked"
									? "linked"
									: "normal"
		},
		{
			enabled: info.item.type === "directory" || info.item.type === "sharedDirectory" || info.item.type === "sharedRootDirectory"
		}
	)

	if (info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile") {
		return ` • ${formatBytes(Number(info.item.data.size))}`
	}

	if (directorySizeQuery.status !== "success") {
		return null
	}

	return ` • ${formatBytes(directorySizeQuery.data.size)}`
})

export default Size
