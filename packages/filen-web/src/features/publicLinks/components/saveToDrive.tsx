import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { AnyItemWithContext } from "@filen/sdk-rs"
import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import { type CopyJobGlyph } from "@/features/drive/lib/copy.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { startLinkedCopyWithCard } from "@/features/transfers/lib/copyToast"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/lib/keymap/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"

export interface SaveToDriveButtonProps {
	// The linked file, or a linked directory with its link (password state included), as the SDK copies it.
	item: AnyItemWithContext
	name: string
	glyph: CopyJobGlyph
	// The slim bars' compact form: small, with the label only from sm up.
	compact?: boolean
}

// Copies what a public link points at into the signed-in visitor's own drive, through drive's own
// destination picker and copy card. The caller renders it only when the link is saveable
// (useLinkSaveable: signed in, not the visitor's own link, downloads allowed).
export function SaveToDriveButton({ item, name, glyph, compact: compactProp }: SaveToDriveButtonProps) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const compact = compactProp ?? false
	const { t } = useTranslation(["publicLinks", "common"])
	const isOnline = useIsOnline()
	const [open, setOpen] = useState(false)
	const Icon = ACTION_DEFS.copy.icon

	// Def in features/publicLinks/lib/keymap.ts: the button, under its own gate. Only one of these shows at a time (the
	// directory on screen, or the file opened from it).
	useAction(
		"links.saveToDrive",
		event => {
			event.preventDefault()

			if (isOnline) {
				setOpen(true)
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	return (
		<>
			<Tooltip disabled={!compact}>
				<TooltipTrigger
					render={
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
					}
				/>
				{/* Only while the label is shed. */}
				<TooltipContent className="sm:hidden">
					{t("saveToDrive")}
					<Kbd action="links.saveToDrive" />
				</TooltipContent>
			</Tooltip>
			{open ? (
				<SaveToDriveDialog
					items={[item]}
					name={name}
					glyph={glyph}
					onClose={() => {
						setOpen(false)
					}}
				/>
			) : null}
		</>
	)
}

export interface SaveToDriveDialogProps {
	// What the link shares, as the SDK copies it: the linked item, or items of a linked directory.
	items: AnyItemWithContext[]
	// The first item's name.
	name: string
	glyph: CopyJobGlyph
	onClose: () => void
}

// Drive's destination picker, then one copy job for every item with its card.
export function SaveToDriveDialog({ items, name, glyph, onClose }: SaveToDriveDialogProps) {
	return (
		<MoveTargetDialog
			items={[]}
			mode="copy"
			onCopy={destination => {
				startLinkedCopyWithCard(items, name, glyph, destination)
			}}
			onClose={onClose}
		/>
	)
}
