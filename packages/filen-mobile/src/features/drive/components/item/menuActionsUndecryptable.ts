import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import { type TFunction } from "i18next"
import {
	buildDeletePermanentlyButton,
	buildRestoreButton,
	buildTrashButton,
	offersTrash
} from "@/features/drive/components/item/menuActionsShared"

// Undecryptable items only support destructive disposition — every other
// action (rename/move/share/download/info/etc.) requires decrypted meta.
// In trash view we surface Restore + Delete-permanently so the user can
// still recover or purge. Everywhere else Trash is the only path forward.
export function buildUndecryptableMenuButtons({ item, drivePath, t }: { item: DriveItem; drivePath: DrivePath; t: TFunction }): MenuButton[] {
	if (drivePath.type === "trash") {
		return item.type === "file" || item.type === "directory"
			? [buildRestoreButton({ item, t }), buildDeletePermanentlyButton({ item, t })]
			: []
	}

	return offersTrash(drivePath) ? [buildTrashButton({ item, t })] : []
}
