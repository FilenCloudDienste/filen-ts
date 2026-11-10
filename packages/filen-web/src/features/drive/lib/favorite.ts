import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { toggleFavorite } from "@/features/drive/lib/actions"
import { favoriteKeys } from "@/features/drive/lib/activity"
import { runOutcomeActivity } from "@/lib/activity/activity"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

// Favorite / Unfavorite, as the item menu entry and preview.favorite run it, with its activity toast. `onToggled` gets
// the updated item for a surface whose items live outside the drive listings (the preview overlay, photos).
export async function toggleItemFavorite(
	item: DriveItem,
	variant: DriveVariant,
	onToggled: ((item: DriveItem) => void) | undefined
): Promise<void> {
	await runOutcomeActivity(item, {
		keys: favoriteKeys(!item.data.favorited),
		name: driveItemName,
		run: async target => {
			const outcome = await toggleFavorite(target)

			if (outcome.status === "error") {
				return outcome
			}

			// Unfavoriting while the favorites listing is open drops the row from that listing (cache patch in
			// actions.ts), so its uuid must not linger in the selection store as a ghost "N selected" count. Favoriting-ON
			// and any non-favorites variant leave the item visible, so selection is left untouched in both of those cases.
			if (variant === "favorites" && !outcome.item.data.favorited) {
				useDriveStore.getState().removeFromSelection([outcome.item.data.uuid])
			}

			onToggled?.(outcome.item)

			return outcome
		}
	})
}
