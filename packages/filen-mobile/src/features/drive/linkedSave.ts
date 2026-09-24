import { type TFunction } from "i18next"
import { AnyDirWithContext, AnyFile, CopyItem } from "@filen/sdk-rs"
import { run } from "@filen/shared"
import { type MenuButton } from "@/components/ui/menu"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import alerts from "@/lib/alerts"
import cache from "@/lib/cache"
import logger from "@/lib/logger"
import { driveItemDisplayName } from "@/lib/decryption"
import { selectCopyDestination } from "@/features/drive/driveSelectSession"
import copyRunner from "@/features/copy/copyRunner"

// Whose ownership decides whether a link view offers "Save to Cloud Drive": a directory link's root
// (everything below it is the same owner's), or a standalone file link's file. Null where nothing may
// be saved: not a link view, a link with downloads disabled, or a link whose SDK source isn't held.
export type LinkSaveTarget = {
	kind: "file" | "directory"
	uuid: string
}

export function linkSaveTarget(drivePath: DrivePath, item?: DriveItem): LinkSaveTarget | null {
	if (drivePath.type !== "linked") {
		return null
	}

	if (drivePath.linked) {
		const root = cache.linkedRootByLinkUuid.get(drivePath.linked.uuid)

		// A copy takes the content just like a download does, so a link that disables downloads offers neither.
		return root?.meta.enableDownload === true ? { kind: "directory", uuid: root.rootUuid } : null
	}

	// A file link can disable downloads, but the SDK's LinkedFile drops that flag, so a visitor can't
	// tell; Download on the same screen is ungated for the same reason.
	return item && cache.linkedFileByUuid.has(item.data.uuid) ? { kind: "file", uuid: item.data.uuid } : null
}

function canCopyLinkedItem(item: DriveItem): boolean {
	return item.type === "file" || (item.type === "directory" && cache.directoryUuidToAnyLinkedDirWithMeta.has(item.data.uuid))
}

// A link-view item as the SDK copies it: a directory with its link, the raw LinkedFile of a standalone
// file link, or a plain File for a file listed inside a linked directory.
export function linkedItemToCopyItem(item: DriveItem): CopyItem | null {
	if (item.type === "directory") {
		const linked = cache.directoryUuidToAnyLinkedDirWithMeta.get(item.data.uuid)

		return linked ? new CopyItem.Dir(new AnyDirWithContext.Linked({ dir: linked.dir, link: linked.meta })) : null
	}

	if (item.type === "file") {
		const linkedFile = cache.linkedFileByUuid.get(item.data.uuid)

		return new CopyItem.File(linkedFile ? new AnyFile.Linked(linkedFile) : new AnyFile.File(item.data))
	}

	return null
}

// The linked directory on screen, the link's root or a subdirectory of it.
export function linkedDirectoryCopySource(drivePath: DrivePath): { item: CopyItem; name: string } | null {
	if (drivePath.type !== "linked" || !drivePath.linked) {
		return null
	}

	const linked = drivePath.uuid
		? cache.directoryUuidToAnyLinkedDirWithMeta.get(drivePath.uuid)
		: cache.linkedRootByLinkUuid.get(drivePath.linked.uuid)

	if (!linked) {
		return null
	}

	const dirItem = drivePath.uuid ? cache.uuidToAnyDriveItem.get(drivePath.uuid) : undefined

	return {
		item: new CopyItem.Dir(new AnyDirWithContext.Linked({ dir: linked.dir, link: linked.meta })),
		name: dirItem ? driveItemDisplayName(dirItem) : drivePath.linked.rootName
	}
}

// "Save to Cloud Drive" for the linked directory on screen.
export function buildSaveLinkedDirectoryButton(drivePath: DrivePath, t: TFunction): MenuButton | null {
	if (!linkedDirectoryCopySource(drivePath)) {
		return null
	}

	return {
		id: "saveDirectoryToCloudDrive",
		title: t("save_to_cloud_drive"),
		icon: "saveToCloud",
		requiresOnline: true,
		onPress: async () => {
			const source = linkedDirectoryCopySource(drivePath)

			if (source) {
				await saveLinkedToDrive({ items: [source.item], name: source.name, t })
			}
		}
	}
}

// Picks a directory in the own drive and copies the link's items into it as one job.
export async function saveLinkedToDrive({ items, name, t }: { items: CopyItem[]; name: string; t: TFunction }): Promise<void> {
	if (items.length === 0) {
		return
	}

	const picked = await run(async () => {
		return await selectCopyDestination([], t("drive"))
	})

	if (!picked.success) {
		logger.error("drive-link", "save to cloud drive: destination picker failed", { error: picked.error })
		alerts.error(picked.error)

		return
	}

	if (!picked.data) {
		return
	}

	const { destination, destinationDir } = picked.data
	const started = await run(async () => {
		return copyRunner.startCopyItems({
			items,
			name,
			destination,
			destinationDir
		})
	})

	if (!started.success) {
		logger.error("drive-link", "save to cloud drive: copy failed to start", { error: started.error, count: items.length })
		alerts.error(started.error)
	}
}

// "Save to Cloud Drive" for link items, offered only when every item's SDK source is held (a directory
// from a restored listing has none until its link is listed again); the sources are built when tapped.
export function buildSaveToCloudDriveButton({
	id,
	title,
	items,
	onDone,
	t
}: {
	id: string
	title: string
	items: DriveItem[]
	onDone?: () => void
	t: TFunction
}): MenuButton | null {
	const first = items[0]

	if (!first || !items.every(canCopyLinkedItem)) {
		return null
	}

	return {
		id,
		title,
		icon: "saveToCloud",
		requiresOnline: true,
		onPress: async () => {
			const copyItems = items.map(linkedItemToCopyItem).filter(item => item !== null)

			onDone?.()

			// The link's cache can have been dropped (logout) since the menu was built.
			if (copyItems.length !== items.length) {
				return
			}

			await saveLinkedToDrive({ items: copyItems, name: driveItemDisplayName(first), t })
		}
	}
}
