import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ExtractTarget } from "@/features/archive/lib/extractSelection"
import type { SelectionTotals } from "@/features/archive/lib/selection"
import { ArchiveExtractMenu } from "@/features/archive/components/archiveExtractMenu"
import { Button } from "@/components/ui/button"

export interface ArchiveFooterProps {
	source: ArchiveSource
	totals: SelectionTotals
	// The new directory each extract would make next to the archive; null for a single compressed file.
	selectedFolderName: string | null
	allFolderName: string | null
	selectedDisabled: boolean
	allDisabled: boolean
	// Why extracting is off (offline, or a link allowing no downloads), as a title.
	disabledTitle: string | undefined
	// Shown above the extracts: why they stay off for good.
	note?: string | undefined
	onExtractSelected: (target: ExtractTarget) => void
	onExtractAll: (target: ExtractTarget) => void
}

// The selection's size and the two extracts. "Extract all" runs at once into a new directory next to an
// own archive, its arrow offering the other places; elsewhere it opens that menu itself.
export function ArchiveFooter({
	source,
	totals,
	selectedFolderName,
	allFolderName,
	selectedDisabled,
	allDisabled,
	disabledTitle,
	note,
	onExtractSelected,
	onExtractAll
}: ArchiveFooterProps) {
	const { t } = useTranslation("preview")
	const allDefault: ExtractTarget | null =
		source.ownParent === undefined ? null : allFolderName === null ? { type: "beside" } : { type: "besideNewFolder" }
	const summary =
		totals.files > 0
			? t("previewArchiveSelectedFiles", { count: totals.files, size: formatBytes(totals.bytes) })
			: totals.entries > 0
				? t("previewArchiveSelectedItems", { count: totals.entries })
				: ""

	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
			{note === undefined ? null : <p className="basis-full text-xs text-muted-foreground">{note}</p>}
			<span
				className="min-w-0 flex-1 truncate text-sm text-muted-foreground tabular-nums"
				aria-live="polite"
			>
				{summary}
			</span>
			<ArchiveExtractMenu
				source={source}
				newFolderName={selectedFolderName}
				label={t("previewArchiveExtractSelected")}
				variant="outline"
				disabled={selectedDisabled}
				disabledTitle={disabledTitle}
				onPick={onExtractSelected}
			/>
			{allDefault === null ? (
				<ArchiveExtractMenu
					source={source}
					newFolderName={allFolderName}
					label={t("previewArchiveExtractAll")}
					variant="default"
					disabled={allDisabled}
					disabledTitle={disabledTitle}
					onPick={onExtractAll}
				/>
			) : (
				<div className="flex items-center gap-px">
					<Button
						disabled={allDisabled}
						title={allDisabled ? disabledTitle : undefined}
						className="rounded-r-md"
						onClick={() => {
							onExtractAll(allDefault)
						}}
					>
						{t("previewArchiveExtractAll")}
					</Button>
					<ArchiveExtractMenu
						source={source}
						newFolderName={allFolderName}
						label={null}
						ariaLabel={t("previewArchiveExtractAllMore")}
						variant="default"
						triggerClassName="rounded-l-md"
						disabled={allDisabled}
						disabledTitle={disabledTitle}
						onPick={onExtractAll}
					/>
				</div>
			)}
		</div>
	)
}
