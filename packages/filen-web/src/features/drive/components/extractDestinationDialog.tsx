import { useTranslation } from "react-i18next"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { extractQuick } from "@/features/drive/lib/archiveActions"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"

export interface ExtractDestinationDialogProps {
	items: DriveItem[]
	variant: DriveVariant
	onClose: () => void
}

// "Choose destination…" for one archive or several: the drive picker, each archive then extracting into
// a new directory of its own there. Mounted-when-active by the dialog host.
export function ExtractDestinationDialog({ items, variant, onClose }: ExtractDestinationDialogProps) {
	const { t } = useTranslation("archive")

	return (
		<MoveTargetDialog
			mode="pick"
			// An archive's contents may land anywhere, its own directory included.
			items={[]}
			pickLabels={{ title: t("archiveExtractPickTitle"), confirm: t("archiveExtractPickConfirm") }}
			// The pick starts the extracts.
			startsWork
			onPick={destination => {
				void extractQuick(items, variant, { type: "to", destination })
			}}
			onClose={onClose}
		/>
	)
}
