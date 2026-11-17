import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderIcon } from "lucide-react"
import type { JobDestination } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { cachedOwnChain } from "@/features/drive/lib/ownAncestry"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

export interface DestinationFieldProps {
	// "Save in", "Extract to", …
	label: string
	destination: JobDestination
	onChange: (destination: JobDestination) => void
	// What the job reads, so the destination can't lie inside one of them; none for an extract.
	sources: DriveItem[]
	// The picker's own title and confirm label.
	pickLabels: { title: string; confirm: string }
	disabled?: boolean | undefined
}

// "<label>: <directory>" with a Change… button opening the drive picker over the dialog it sits in
// (nested, so focus and Escape stay with the picker while it is open).
export function DestinationField({ label, destination, onChange, sources, pickLabels, disabled }: DestinationFieldProps) {
	const { t } = useTranslation(["archive", "drive"])
	const id = useId()
	// The picker's starting chain while it is open; read from the cache only when it opens.
	const [pickerPath, setPickerPath] = useState<string[] | null>(null)

	return (
		<div className="flex flex-col gap-3">
			<Label id={`${id}-label`}>{label}</Label>
			<div className="flex items-center gap-2">
				<div
					className="flex min-w-0 flex-1 items-center gap-2 text-sm"
					aria-labelledby={`${id}-label`}
					role="group"
				>
					<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
					<span className="truncate">{destination.uuid === null ? t("drive:driveMyDrive") : destination.name}</span>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					aria-describedby={`${id}-label`}
					onClick={() => {
						setPickerPath(cachedOwnChain(destination.uuid))
					}}
				>
					{t("archiveChangeDestination")}
				</Button>
			</div>
			{pickerPath !== null ? (
				<MoveTargetDialog
					mode="pick"
					items={sources}
					initialPath={pickerPath}
					pickLabels={pickLabels}
					onPick={onChange}
					onClose={() => {
						setPickerPath(null)
					}}
				/>
			) : null}
		</div>
	)
}
