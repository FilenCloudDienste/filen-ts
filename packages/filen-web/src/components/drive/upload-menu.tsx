import { useRef, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { UploadIcon } from "lucide-react"
import { startUploads } from "@/lib/drive/upload"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface UploadMenuProps {
	// The directory uploaded files land in — the current listing's own uuid (null at My Drive's root).
	parentUuid: string | null
	// True outside the "drive" variant (recents/favorites/trash/shared have no navigable directory to
	// upload into) or while the listing hasn't loaded yet — mirrors NewDirectory's disabled-not-hidden
	// convention so the toolbar's layout stays stable across variant switches.
	disabled?: boolean
}

// Toolbar entry point for starting an upload. A DropdownMenu (not a bare button) so a later "Upload
// directory" entry (the webkitdirectory input) can sit next to "Upload files" without restructuring
// this component — driveUploadDirectory in locales/en/drive.ts is already reserved for it.
//
// The picker itself is a hidden <input type="file" multiple>, triggered via ref+click (mirrors
// master-keys-file-field.tsx) — its value is reset after every pick so choosing the exact same
// file(s) again still fires change.
export function UploadMenu({ parentUuid, disabled = false }: UploadMenuProps) {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)

	function handleFilesChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startUploads(files, parentUuid)
		e.target.value = ""
	}

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				disabled={disabled}
				className="hidden"
				onChange={handleFilesChosen}
			/>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							disabled={disabled}
						>
							<UploadIcon />
							{t("driveUploadMenuTrigger")}
						</Button>
					}
				/>
				<DropdownMenuContent>
					<DropdownMenuItem
						onClick={() => {
							inputRef.current?.click()
						}}
					>
						{t("driveUploadFiles")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}
