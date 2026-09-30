import type { SelectOptions } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import { type AnyNormalDir } from "@filen/sdk-rs"
import { router } from "@/lib/router"
import type { DriveSelectedItem, Events } from "@/lib/events"
import auth from "@/lib/auth"
import { awaitPickerEvent } from "@/lib/awaitPickerEvent"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import { serializeSelectOptions } from "@/features/drive/driveSelectParams"
import type { CopyDestination } from "@/features/copy/copyAdapter"
import { copyDestinationOf } from "@/features/drive/copyDestination"
import { resolveSelectedDriveItemToAnyNormalDir } from "@/features/drive/driveSelectResolve"

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

// Opens a picker session at the drive root and resolves with `resolveWith` applied to its result event.
async function awaitDriveSelect<R>(options: Omit<SelectOptions, "id" | "itemUuids">, resolveWith: (data: Events["driveSelect"]) => R): Promise<R> {
	const { authedSdkClient } = await auth.getSdkClients()
	const rootUuid = authedSdkClient.root().uuid

	return awaitPickerEvent(
		"driveSelect",
		id => {
			openDriveSelect({
				rootUuid,
				options: {
					...options,
					id
				}
			})
		},
		resolveWith
	)
}

export async function selectDriveItems(
	options: Omit<SelectOptions, "intention" | "id" | "itemUuids" | "items"> & { items?: DriveItem[] }
): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedItems: DriveSelectedItem[]
	  }
> {
	return awaitDriveSelect(
		{
			...options,
			items: options.items ?? [],
			intention: "select"
		},
		data =>
			data.cancelled || data.selectedItems.length === 0
				? {
						cancelled: true
					}
				: {
						cancelled: false,
						selectedItems: data.selectedItems
					}
	)
}

// Picks one destination directory, resolved to the AnyNormalDir a caller uploads into. Null when the picker
// is dismissed or the pick is not a usable destination (the resolver logs that case).
export async function selectDriveDirectory(initiallySelected?: DriveItem[]): Promise<AnyNormalDir | null> {
	const result = await selectDriveItems({
		type: "single",
		files: false,
		directories: true,
		initiallySelected
	})

	const selectedItem = result.cancelled ? undefined : result.selectedItems[0]

	return selectedItem ? resolveSelectedDriveItemToAnyNormalDir(selectedItem) : null
}

// Picks where `items` get copied to: the directory the picker is showing when "Copy here" is tapped, or
// null when it is dismissed. The caller starts the copy.
export async function selectCopyDestination(items: DriveItem[]): Promise<{ destinationDir: AnyNormalDir; destination: CopyDestination } | null> {
	return awaitDriveSelect(
		{
			type: "single",
			files: false,
			directories: true,
			intention: "copy",
			items
		},
		data => {
			const picked = data.cancelled ? undefined : data.selectedItems[0]

			if (!picked || picked.type !== "root") {
				return null
			}

			return {
				destinationDir: picked.data,
				destination: copyDestinationOf(picked.data)
			}
		}
	)
}
