import type { SelectOptions } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import { type AnyNormalDir } from "@filen/sdk-rs"
import { randomUUID } from "expo-crypto"
import { router } from "@/lib/router"
import auth from "@/lib/auth"
import events from "@/lib/events"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"
import { serializeSelectOptions } from "@/features/drive/driveSelectParams"
import type { CopyDestination } from "@/features/copy/copyAdapter"
import { copyDestinationOf } from "@/features/drive/clipboard"

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

export async function selectDriveItems(options: Omit<SelectOptions, "intention" | "id" | "itemUuids">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedItems: (
				| {
						type: "driveItem"
						data: DriveItem
				  }
				| {
						type: "root"
						data: AnyNormalDir
				  }
			)[]
	  }
> {
	const { authedSdkClient } = await auth.getSdkClients()
	const rootUuid = authedSdkClient.root().uuid

	return new Promise(resolve => {
		const id = randomUUID()

		const sub = events.subscribe("driveSelect", data => {
			if (data.id === id) {
				sub.remove()

				if (data.cancelled || data.selectedItems.length === 0) {
					resolve({
						cancelled: true
					})

					return
				}

				resolve({
					cancelled: false,
					selectedItems: data.selectedItems
				})
			}
		})

		openDriveSelect({
			rootUuid,
			options: {
				...options,
				intention: "select",
				id
			}
		})
	})
}

// Picks where `items` get copied to: the directory the picker is showing when "Copy here" is tapped, or
// null when it is dismissed. The caller starts the copy. `rootName` names the drive root as a destination.
export async function selectCopyDestination(
	items: DriveItem[],
	rootName: string
): Promise<{ destinationDir: AnyNormalDir; destination: CopyDestination } | null> {
	const { authedSdkClient } = await auth.getSdkClients()
	const rootUuid = authedSdkClient.root().uuid

	return new Promise(resolve => {
		const id = randomUUID()

		const sub = events.subscribe("driveSelect", data => {
			if (data.id !== id) {
				return
			}

			sub.remove()

			const picked = data.cancelled ? undefined : data.selectedItems[0]

			if (!picked || picked.type !== "root") {
				resolve(null)

				return
			}

			resolve({
				destinationDir: picked.data,
				destination: copyDestinationOf(picked.data, rootUuid, rootName)
			})
		})

		openDriveSelect({
			rootUuid,
			options: {
				type: "single",
				files: false,
				directories: true,
				intention: "copy",
				items,
				id
			}
		})
	})
}
