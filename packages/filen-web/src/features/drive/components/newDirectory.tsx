import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FolderPlusIcon } from "lucide-react"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runCreateDirectory } from "@/features/drive/lib/createDirectory"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { InputDialog } from "@/components/dialogs/inputDialog"

// Module scope, not inside the component: runs exactly once per module evaluation, which is what
// `registerAction`'s duplicate-id guard assumes (see themeProvider.tsx's own "app.toggleTheme"
// registration for the full StrictMode/HMR rationale — identical here).
registerAction({
	id: "drive.newDirectory",
	defaultCombo: "n",
	scope: "drive",
	descriptionKey: "driveCommandNewDirectory"
})

export interface NewDirectoryProps {
	// The directory the created one is created into — the current listing's own uuid (null at My
	// Drive's root).
	parentUuid: string | null
	// True outside a writable location (canWriteVariant — the "drive" variant, or an owned nested
	// sharedOut directory) or while the listing hasn't loaded yet — mirrors SortMenu's
	// disabled-not-hidden convention so the toolbar's layout stays stable across variant switches.
	disabled?: boolean
	// directoryListing.tsx's own useDriveDialogHost().isDialogOpen — true while ANY of that host's
	// dialogs (including the preview overlay, kind:"preview") is open. Threaded in rather than read
	// here directly since the host lives one level up; guards this action the same way its
	// drive.selectAll/clearSelection/toggleView/rename/trash/download siblings guard themselves in
	// directoryListing.tsx.
	dialogOpen: boolean
	// True only when `disabled` is caused specifically by the app being offline (a subset of
	// `disabled`'s own broader gate) — swaps the tooltip's copy from the action label to the offline
	// explanation so a proactively-disabled control still tells the user why.
	offline?: boolean
}

export function NewDirectory({ parentUuid, disabled = false, dialogOpen, offline = false }: NewDirectoryProps) {
	const { t } = useTranslation(["drive", "common"])
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	// Registered above at module scope. Guards on `disabled`/`dialogOpen` themselves (rather than
	// being conditionally registered/mounted) since a keyboard command's live handler must stay a
	// plain hook call.
	useAction(
		"drive.newDirectory",
		() => {
			if (!disabled && !dialogOpen) {
				setOpen(true)
			}
		},
		undefined,
		[disabled, dialogOpen]
	)

	async function handleSubmit(name: string): Promise<void> {
		setPending(true)

		const outcome = await runCreateDirectory(
			{ createDirectory: (parent, next) => sdkApi.createDirectory(parent, next), patchListing: driveListingQueryUpdate },
			parentUuid,
			name.trim()
		)

		setPending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash with a file) so the user can fix the name
			// and retry — mirrors every other write flow's toast.error(errorLabel(...)) convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setOpen(false)
	}

	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							disabled={disabled}
							onClick={() => {
								setOpen(true)
							}}
						>
							<FolderPlusIcon />
							{t("driveNewDirectoryTitle")}
						</Button>
					}
				/>
				<TooltipContent>
					{offline && disabled ? t("common:offlineActionDisabled") : t("driveNewDirectoryTitle")}
					<Kbd action="drive.newDirectory" />
				</TooltipContent>
			</Tooltip>
			<InputDialog
				open={open}
				pending={pending}
				title={t("driveNewDirectoryTitle")}
				body={t("driveNewDirectoryBody")}
				label={t("driveNewDirectoryLabel")}
				placeholder={t("driveNewDirectoryPlaceholder")}
				submitLabel={t("driveNewDirectorySubmit")}
				validate={name => name.trim().length > 0}
				onOpenChange={setOpen}
				onSubmit={value => {
					void handleSubmit(value)
				}}
			/>
		</>
	)
}
