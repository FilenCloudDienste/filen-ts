import type { ListRenderItemInfo } from "@/components/ui/virtualList"
import type { DriveItem } from "@/types"
import useDirectorySizeQuery from "@/features/drive/queries/useDirectorySize.query"
import { formatBytes } from "@filen/utils"
import type { DrivePath } from "@/hooks/useDrivePath"
import { directorySizeTypeForDrivePath } from "@/features/drive/utils"

const Size = ({ info, drivePath }: { info: ListRenderItemInfo<DriveItem>; drivePath: DrivePath }) => {
	const directorySizeQuery = useDirectorySizeQuery(
		{
			uuid: info.item.data.uuid,
			type: directorySizeTypeForDrivePath(drivePath.type),
			// Thread the row's own item so the size resolves by value even when the session-scoped
			// uuid cache never observed this directory.
			item: info.item
		},
		{
			enabled: info.item.type === "directory" || info.item.type === "sharedDirectory" || info.item.type === "sharedRootDirectory"
		}
	)

	if (info.item.type === "file" || info.item.type === "sharedFile" || info.item.type === "sharedRootFile") {
		return ` • ${formatBytes(Number(info.item.data.size))}`
	}

	// Gate on data presence, not status: hide the label while there is no size (pending / hard
	// unresolved) so a wrong "0 B" is never shown, but keep rendering a prior size through a failed
	// refetch (status flips to error while data is retained — stale-while-error, as the listing does).
	if (!directorySizeQuery.data) {
		return null
	}

	return ` • ${formatBytes(directorySizeQuery.data.size)}`
}

export default Size
