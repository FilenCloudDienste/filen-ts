import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export interface ArchiveLinkTargetsDialogProps {
	open: boolean
	// Selected hard links whose files lie outside the base directory.
	count: number
	// The directory shown, which the extract's paths start from.
	baseName: string
	// The nearest directory holding the base and every link target.
	parentName: string
	// Absent when the selection holds nothing but those links.
	onLeaveOut?: (() => void) | undefined
	onFromParent: () => void
	onCancel: () => void
}

// An extract from a directory can't create a hard link's file outside it (the SDK refuses the call), so
// the user picks: leave those links out, or take the paths from a directory high enough to hold both.
export function ArchiveLinkTargetsDialog({
	open,
	count,
	baseName,
	parentName,
	onLeaveOut,
	onFromParent,
	onCancel
}: ArchiveLinkTargetsDialogProps) {
	const { t } = useTranslation(["preview", "common"])

	return (
		<Dialog
			open={open}
			onOpenChange={next => {
				if (!next) {
					onCancel()
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("previewArchiveLinkTargetsTitle")}</DialogTitle>
					<DialogDescription>{t("previewArchiveLinkTargetsBody", { count, base: baseName })}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={onCancel}
					>
						{t("common:cancel")}
					</Button>
					<Button
						variant={onLeaveOut === undefined ? "default" : "outline"}
						autoFocus={onLeaveOut === undefined}
						onClick={onFromParent}
					>
						<span className="min-w-0 truncate">{t("previewArchiveLinkTargetsFromParent", { name: parentName })}</span>
					</Button>
					{onLeaveOut === undefined ? null : (
						<Button
							autoFocus
							onClick={onLeaveOut}
						>
							{t("previewArchiveLinkTargetsLeaveOut")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
