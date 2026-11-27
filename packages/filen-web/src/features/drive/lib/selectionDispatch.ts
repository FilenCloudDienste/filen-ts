import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type DriveNavigationTarget } from "@/features/drive/lib/navigate"
import { restoreItems, setFavoritedItems } from "@/features/drive/lib/actions"
import { toggleItemFavorite } from "@/features/drive/lib/favorite"
import { defaultRevealDeps, runOpenContainingDirectory } from "@/features/drive/lib/reveal"
import { copyItemLink } from "@/features/drive/lib/copyLink"
import { DRIVE_RESTORE, driveActivity, favoriteKeys } from "@/features/drive/lib/activity"
import { startDownloads } from "@/features/drive/lib/download"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { type DriveActionDescriptor, type DriveActionDialogKind } from "@/features/drive/lib/selectionActions"
import { runBulkActivity } from "@/lib/activity/activity"
import { copyText } from "@/lib/copyText"
import { i18n } from "@/lib/i18n"
import { queueDriveSongs } from "@/features/audio/lib/queueActions"

export type DriveDialogAction = (kind: DriveActionDialogKind, items: DriveItem[], startPath?: readonly string[]) => void

export interface DriveActionHandlers {
	variant: DriveVariant
	// Every "dialog" entry, on the items it was offered for.
	onDialogAction: DriveDialogAction
	// The surface's own open (a row's double-click); Open is offered only where it is present.
	onOpen?: (() => void) | undefined
	// For a surface whose items live outside the drive listings (the preview overlay, photos): the updated item the
	// instant a favorite or restore of one item resolves.
	onFavoriteToggled?: ((item: DriveItem) => void) | undefined
	onRestored?: ((item: DriveItem) => void) | undefined
	// Open containing directory's route change.
	navigate: (target: DriveNavigationTarget) => void
}

// A selection's favorite SETS one state on all of it: favorited unless any already is.
export async function runBulkFavorite(items: DriveItem[]): Promise<void> {
	const favorited = !aggregateDriveSelectionFlags(items).includesFavorited

	await runBulkActivity(
		driveActivity(items, favoriteKeys(favorited), (targets, onSettled) => setFavoritedItems(targets, favorited, onSettled))
	)
}

// Runs an entry of driveSelectionActions on the items it was built for, from a click or a key. Synchronous up to the
// first await of each arm: a download's save picker and a clipboard write need the event's live user activation, which
// Safari ends at the first await, so nothing here yields ahead of them.
export function runDriveAction(descriptor: DriveActionDescriptor, items: DriveItem[], handlers: DriveActionHandlers): void {
	const [first] = items
	const single = items.length === 1 ? first : undefined

	switch (descriptor.id) {
		case "download":
			void startDownloads(items)
			return
		case "copyId":
			if (single !== undefined) {
				void copyText(single.data.uuid, i18n.t("drive:driveCopyIdToast"))
			}

			return
		case "open":
			// Off the click, like the double-click it mirrors: audio starts playback from here.
			handlers.onOpen?.()
			return
		case "copyLink":
			// The existing link straight to the clipboard, the link dialog when there is none yet.
			if (single !== undefined) {
				void copyItemLink(single, i18n.t("drive:driveLinkUrlCopiedToast"), () => {
					handlers.onDialogAction("link", [single])
				})
			}

			return
		case "favorite":
			void (single === undefined ? runBulkFavorite(items) : toggleItemFavorite(single, handlers.variant, handlers.onFavoriteToggled))
			return
		case "openContainingDirectory":
			if (single !== undefined) {
				void runOpenContainingDirectory(defaultRevealDeps, single, handlers.navigate)
			}

			return
		case "playNext":
			queueDriveSongs(items, "next")
			return
		case "addToQueue":
			queueDriveSongs(items, "end")
			return
		// Submenus on every surface: their entries run the action.
		case "downloadAs":
		case "addToPlaylist":
			return
		default:
			break
	}

	if (descriptor.run === "dialog") {
		handlers.onDialogAction(descriptor.dialogKind, items)
		return
	}

	// One item's restore, the remaining direct entry (a selection's confirms through "restoreSelected"). A restored item
	// leaves the trash listing, so a success also drops it from the selection.
	if (descriptor.id === "restore" && single !== undefined) {
		void runBulkActivity(
			driveActivity([single], DRIVE_RESTORE, restoreItems, {
				onDone: outcome => {
					if (outcome.succeeded.length > 0) {
						handlers.onRestored?.(single)
					}
				}
			})
		)
	}
}
