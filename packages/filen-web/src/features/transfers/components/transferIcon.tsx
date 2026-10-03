import { FilesIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { transferIconKey } from "@/features/transfers/components/transferRow.logic"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import { isDriveJobDirection, type Transfer } from "@/features/transfers/store/useTransfersStore"

// A transfer's item glyph: a drive job shows what it makes or moves (one directory, one file or several
// items; a compress its archive's file type), any other transfer its file's type.
export function TransferIcon({ transfer, className }: { transfer: Transfer; className: string }) {
	const glyph = useDriveJobsStore(state => (isDriveJobDirection(transfer.direction) ? state.jobs[transfer.id]?.glyph : undefined))

	if (glyph === "directory") {
		return (
			<DirectoryGlyph
				color="default"
				className={className}
			/>
		)
	}

	if (glyph === "items") {
		return (
			<FilesIcon
				aria-hidden="true"
				className={cn(className, "text-muted-foreground")}
			/>
		)
	}

	return (
		<FileTypeIcon
			iconKey={transferIconKey(transfer)}
			className={className}
		/>
	)
}
