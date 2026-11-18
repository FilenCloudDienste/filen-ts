import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useIsOnline } from "@/lib/useIsOnline"
import { extractArchiveTo } from "@/features/drive/lib/archiveActions"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { Button } from "@/components/ui/button"

// The archive (a comic, or the archive of an entry packed too large to read from here, E3) into a directory of the
// user's drive, picked first; the extract then runs on with its own card.
export function ExtractToRead({ source }: { source: ArchiveSource }) {
	const { t } = useTranslation(["preview", "archive", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)

	return (
		<>
			<Button
				variant="outline"
				disabled={!isOnline}
				title={isOnline ? undefined : t("common:offlineActionDisabled")}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("previewComicExtractToRead")}
			</Button>
			{open ? (
				<MoveTargetDialog
					mode="pick"
					items={[]}
					pickLabels={{ title: t("archive:archiveExtractPickTitle"), confirm: t("archive:archiveExtractPickConfirm") }}
					startsWork
					onPick={destination => {
						void extractArchiveTo(source, destination)
					}}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}
