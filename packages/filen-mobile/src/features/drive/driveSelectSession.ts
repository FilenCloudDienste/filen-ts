import type { SelectOptions } from "@/hooks/useDrivePath"
import { router } from "@/lib/router"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import { serializeSelectOptions } from "@/features/drive/driveSelectParams"

// Opens a picker session over `options.items` and pushes its first screen at the drive root. The items
// stay in the session store until that root screen unmounts; the route carries only the session id.
export function openDriveSelect({ rootUuid, options }: { rootUuid: string; options: Omit<SelectOptions, "itemUuids"> }): void {
	useDriveSelectStore.getState().openSession(options.id, options.items, options.initiallySelected)

	router.push({
		pathname: "/driveSelect/[uuid]",
		params: {
			uuid: rootUuid,
			selectOptions: serializeSelectOptions(options)
		}
	})
}
