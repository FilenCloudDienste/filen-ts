import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FolderPlusIcon } from "lucide-react"
import { useAction } from "@/lib/keymap/useAction"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { Kbd } from "@/lib/keymap/kbd"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runCreateDirectory } from "@/features/drive/lib/createDirectory"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface NewDirectoryProps {
	// The directory the created one is created into — the current listing's own uuid (null at My
	// Drive's root).
	parentUuid: string | null
	// True outside a writable location (canWriteVariant — the "drive" variant, or an owned nested
	// sharedOut directory) or while the listing hasn't loaded yet — mirrors SortMenu's
	// disabled-not-hidden convention so the toolbar's layout stays stable across variant switches.
	disabled?: boolean
	// True only when `disabled` is caused specifically by the app being offline (a subset of
	// `disabled`'s own broader gate) — swaps the tooltip's copy from the action label to the offline
	// explanation so a proactively-disabled control still tells the user why.
	offline?: boolean
	// True when this listing would actually hide a dot-prefixed name (the preference AND
	// hiddenFilterAppliesTo) — computed once by the listing, since it already holds both halves.
	hiddenNotice?: boolean
	// False for a second copy of the control on the same screen, so one keypress opens one dialog.
	// Defaults to true.
	shortcut?: boolean
}

// No destructuring defaults: the React Compiler cannot lower them and would skip the whole component.
export function NewDirectory({ parentUuid, disabled, offline, hiddenNotice, shortcut }: NewDirectoryProps) {
	const { t } = useTranslation(["drive", "common"])
	const [open, setOpen] = useState(false)
	const isDisabled = disabled === true

	// Registered above at module scope. Guards on `disabled` and an open dialog itself (rather than
	// being conditionally registered/mounted) since a keyboard command's live handler must stay a
	// plain hook call. A copy without the shortcut attaches no listener at all.
	useAction(
		"drive.newDirectory",
		() => {
			if (!isDisabled && !isAnyDialogOpen()) {
				setOpen(true)
			}
		},
		{ enabled: shortcut !== false },
		[isDisabled]
	)

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							// Label sheds below sm — see uploadMenu.tsx's matching trigger for why the aria-label is
							// the same key.
							aria-label={t("driveNewDirectoryTitle")}
							disabled={isDisabled}
							onClick={() => {
								setOpen(true)
							}}
						>
							<FolderPlusIcon />
							<span className="hidden sm:inline">{t("driveNewDirectoryTitle")}</span>
						</Button>
					}
				/>
				<TooltipContent>
					{offline === true && isDisabled ? t("common:offlineActionDisabled") : t("driveNewDirectoryTitle")}
					<Kbd action="drive.newDirectory" />
				</TooltipContent>
			</Tooltip>
			<NewDirectoryDialog
				open={open}
				onOpenChange={setOpen}
				parentUuid={parentUuid}
				hiddenNotice={hiddenNotice === true}
			/>
		</>
	)
}

export interface NewDirectoryDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	// The directory the new one is created in, null for My Drive's root.
	parentUuid: string | null
	hiddenNotice: boolean
}

// The name dialog behind New directory — the toolbar button above and the sidebar tree's menu.
export function NewDirectoryDialog({ open, onOpenChange, parentUuid, hiddenNotice }: NewDirectoryDialogProps) {
	const { t } = useTranslation("drive")
	const [pending, setPending] = useState(false)

	async function handleSubmit(name: string): Promise<void> {
		setPending(true)

		const trimmed = name.trim()
		const outcome = await runCreateDirectory(
			{ createDirectory: (parent, next) => sdkApi.createDirectory(parent, next), patchListing: driveListingQueryUpdate },
			parentUuid,
			trimmed
		)

		setPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash with a file) so the user can fix the name
			// and retry — mirrors every other write flow's toast.error(errorLabel(...)) convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		onOpenChange(false)
		// Creating has no success feedback of its own — the row appearing IS the feedback — so a name
		// the display filter will swallow needs to say so.
		notifyIfNameIsHidden(trimmed, "created", hiddenNotice)
	}

	return (
		<InputDialog
			open={open}
			pending={pending}
			title={t("driveNewDirectoryTitle")}
			body={t("driveNewDirectoryBody")}
			label={t("driveNewDirectoryLabel")}
			placeholder={t("driveNewDirectoryPlaceholder")}
			submitLabel={t("driveNewDirectorySubmit")}
			validate={name => name.trim().length > 0}
			onOpenChange={onOpenChange}
			onSubmit={value => {
				void handleSubmit(value)
			}}
		/>
	)
}
