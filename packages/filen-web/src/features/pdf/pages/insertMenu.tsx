import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, CloudIcon, FilePlusIcon, HardDriveIcon, ImageIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface PdfInsertMenuProps {
	readonly disabled?: boolean
	readonly onBlank: () => void
	// The host opens the drive picker (PDF files only).
	readonly onFromFilen: () => void
	// A PDF picked on this device.
	readonly onFromDevice: (file: File) => void
	// A picture picked on this device.
	readonly onImage: (file: File) => void
}

// Insert ▾: a blank page, the pages of another PDF (from the drive or this device), or a picture as a page. New
// pages go after the current one; the host decides. Device files come through hidden file inputs, so the browser's
// own picker opens from the menu item's click.
export function PdfInsertMenu({ disabled, onBlank, onFromFilen, onFromDevice, onImage }: PdfInsertMenuProps) {
	const { t } = useTranslation("preview")
	const pdfInput = useRef<HTMLInputElement | null>(null)
	const imageInput = useRef<HTMLInputElement | null>(null)
	const picked = (input: HTMLInputElement, take: (file: File) => void): void => {
		const file = input.files?.[0]

		// Cleared, so picking the same file again fires a change.
		input.value = ""

		if (file !== undefined) take(file)
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={disabled}
					render={
						<Button
							variant="ghost"
							size="sm"
						>
							<FilePlusIcon aria-hidden="true" />
							{t("previewPdfPagesInsert")}
							<ChevronDownIcon aria-hidden="true" />
						</Button>
					}
				/>
				<DropdownMenuContent>
					<DropdownMenuItem onClick={onBlank}>
						<FilePlusIcon aria-hidden="true" />
						{t("previewPdfPagesInsertBlank")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onFromFilen}>
						<CloudIcon aria-hidden="true" />
						{t("previewPdfPagesInsertFromFilen")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							pdfInput.current?.click()
						}}
					>
						<HardDriveIcon aria-hidden="true" />
						{t("previewPdfPagesInsertFromDevice")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							imageInput.current?.click()
						}}
					>
						<ImageIcon aria-hidden="true" />
						{t("previewPdfPagesInsertImage")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<input
				ref={pdfInput}
				type="file"
				accept="application/pdf,.pdf"
				hidden
				onChange={event => {
					picked(event.currentTarget, onFromDevice)
				}}
			/>
			<input
				ref={imageInput}
				type="file"
				accept="image/*"
				hidden
				onChange={event => {
					picked(event.currentTarget, onImage)
				}}
			/>
		</>
	)
}
