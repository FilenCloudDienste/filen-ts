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
// `registerAction`'s duplicate-id guard assumes (see theme-provider.tsx's own "app.toggleTheme"
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
	// True outside the "drive" variant (recents/favorites/trash have no navigable parent to create
	// into) or while the listing hasn't loaded yet — mirrors SortMenu's disabled-not-hidden
	// convention so the toolbar's layout stays stable across variant switches.
	disabled?: boolean
}

export function NewDirectory({ parentUuid, disabled = false }: NewDirectoryProps) {
	const { t } = useTranslation("drive")
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	// Registered above at module scope. Guards on `disabled` itself (rather than being conditionally
	// registered/mounted) since a keyboard command's live handler must stay a plain hook call.
	useAction(
		"drive.newDirectory",
		() => {
			if (!disabled) {
				setOpen(true)
			}
		},
		undefined,
		[disabled]
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
					{t("driveNewDirectoryTitle")}
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
