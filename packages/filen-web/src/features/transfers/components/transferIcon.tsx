import { FilesIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { transferIconKey } from "@/features/transfers/components/transferRow.logic"
import { DirectoryGlyph, FileTypeIcon } from "@/features/drive/components/itemIcon"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"

// A transfer's item glyph: a copy shows what it copies (one directory, one file or several items), any
// other transfer its file's type.
export function TransferIcon({ transfer, className }: { transfer: Transfer; className: string }) {
	const glyph = useCopyJobsStore(state => (transfer.direction === "copy" ? state.jobs[transfer.id]?.glyph : undefined))

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
