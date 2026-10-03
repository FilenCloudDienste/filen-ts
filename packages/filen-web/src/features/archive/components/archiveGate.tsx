import { useTranslation } from "react-i18next"
import type { ArchiveFormat } from "@filen/sdk-rs"
import { FileArchiveIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { gateFor } from "@/features/archive/lib/archiveGate.logic"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"
import { ArchiveExtractMenu } from "@/features/archive/components/archiveExtractMenu"
import { Button } from "@/components/ui/button"

export interface ArchiveGateProps {
	source: ArchiveSource
	format: ArchiveFormat | null
	// What "Extract all" names its new directory; null for a single compressed file.
	newFolderName: string | null
	extractDisabled: boolean
	extractDisabledTitle: string | undefined
	onBrowse: () => void
	onExtractAll: (target: ExtractTarget) => void
}

// A tarball or single compressed file lists only by reading all of it, so it waits for the user's word:
// stepping past one in the pager costs nothing. Any archive shows it once its listing was cancelled
// before reading anything.
export function ArchiveGate({
	source,
	format,
	newFolderName,
	extractDisabled,
	extractDisabledTitle,
	onBrowse,
	onExtractAll
}: ArchiveGateProps) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
			<FileArchiveIcon
				aria-hidden="true"
				className="size-10 text-muted-foreground"
			/>
			<p className="max-w-sm text-sm text-muted-foreground">
				{gateFor(format, source.size) === "gate"
					? t("previewArchiveGateBody", { size: formatBytes(source.size) })
					: t("previewArchiveNotListed")}
			</p>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button onClick={onBrowse}>{t("previewArchiveBrowse")}</Button>
				<ArchiveExtractMenu
					source={source}
					newFolderName={newFolderName}
					label={t("previewArchiveExtractAll")}
					variant="outline"
					disabled={extractDisabled}
					disabledTitle={extractDisabledTitle}
					onPick={onExtractAll}
				/>
			</div>
		</div>
	)
}
