import { useEffect, useRef, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { UploadIcon } from "lucide-react"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
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

// Toolbar entry point for starting an upload. A DropdownMenu (not a bare button) holds both "Upload
// files" and "Upload directory" side by side.
//
// Each picker is a hidden <input type="file">, triggered via ref+click (mirrors
// masterKeysFileField.tsx) — its value is reset after every pick so choosing the exact same
// file(s)/directory again still fires change.
export function UploadMenu({ parentUuid, disabled = false }: UploadMenuProps) {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)
	const directoryInputRef = useRef<HTMLInputElement>(null)

	// `webkitdirectory` has no slot in React's InputHTMLAttributes (it IS a real HTMLInputElement
	// property — lib.dom.d.ts declares it — just not one React's JSX typings expose), so it's set
	// imperatively on the real DOM node instead of a typed-spread hack.
	useEffect(() => {
		const input = directoryInputRef.current

		if (input) {
			input.webkitdirectory = true
		}
	}, [])

	function handleFilesChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startUploads(files, parentUuid)
		e.target.value = ""
	}

	function handleDirectoryChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startDirectoryUpload({ kind: "files", files }, parentUuid)
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
			<input
				id="drive-upload-directory-input"
				ref={directoryInputRef}
				type="file"
				disabled={disabled}
				className="hidden"
				onChange={handleDirectoryChosen}
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
					<DropdownMenuItem
						onClick={() => {
							directoryInputRef.current?.click()
						}}
					>
						{t("driveUploadDirectory")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}
