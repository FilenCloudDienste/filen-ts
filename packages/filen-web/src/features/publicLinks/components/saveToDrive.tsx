import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { CopyItem } from "@filen/sdk-rs"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { startLinkedCopyWithCard } from "@/features/transfers/lib/copyToast"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"

export interface SaveToDriveButtonProps {
	// The linked file, or a linked directory with its link (password state included), as the SDK copies it.
	item: CopyItem
	name: string
	glyph: CopyJobGlyph
	// The slim bars' compact form: small, with the label only from sm up.
	compact?: boolean
}

// Copies what a public link points at into the signed-in visitor's own drive, through drive's own
// destination picker and copy card. The caller renders it only when the link is saveable
// (useLinkSaveable: signed in, not the visitor's own link, downloads allowed).
export function SaveToDriveButton({ item, name, glyph, compact = false }: SaveToDriveButtonProps) {
	const { t } = useTranslation(["publicLinks", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const Icon = ACTION_DEFS.copy.icon

	return (
		<>
			<Button
				variant="outline"
				size={compact ? "sm" : "default"}
				disabled={!isOnline}
				title={isOnline ? undefined : t("common:offlineActionDisabled")}
				aria-label={compact ? t("saveToDrive") : undefined}
				onClick={() => {
					setOpen(true)
				}}
			>
				<Icon data-icon="inline-start" />
				{compact ? <span className="hidden sm:inline">{t("saveToDrive")}</span> : t("saveToDrive")}
			</Button>
			{open ? (
				<MoveTargetDialog
					items={[]}
					mode="copy"
					onCopy={destination => {
						startLinkedCopyWithCard(item, name, glyph, destination)
					}}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}
