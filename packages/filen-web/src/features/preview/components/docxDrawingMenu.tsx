import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { CaptionsIcon, CropIcon, RotateCwIcon, Trash2Icon, WrapTextIcon } from "lucide-react"
import type { DocxEditorCommandType } from "@filen/office/core/docx/edit"
import { cn } from "@filen/shared"
import { keepFocus, type DocxDrawingItem, type DocxToolbarSlotProps } from "@/features/preview/components/docxEditor.logic"
import { ROTATE_VARIANTS, WRAP_VARIANTS } from "@/features/preview/components/docxCommandLabels/drawings"
import { setDrawingCrop, useDrawingCrop } from "@/features/preview/components/docxDrawingCrop"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// The ribbon's contextual Picture tab while a picture is selected: Wrap text, Rotate, Crop (page view: its handles
// on the page), Alt text and Delete; resizing and moving are the handles'. In Mobile view the tab shows without
// cropping. The context menu asks for crop and alt text through the input channel too.

export interface DocxDrawingMenuProps extends DocxToolbarSlotProps {
	// The items offered (drawingItems).
	items: readonly DocxDrawingItem[]
}

// Whether the selected picture can be cropped here: the pages show its handles.
function cropPossible(props: DocxToolbarSlotProps): boolean {
	const { commands, snapshot, readOnly, surface } = props

	return (
		surface === "pages" &&
		commands.some(command => command.info.type === "drawing.crop") &&
		snapshot?.context.drawing?.croppable === true &&
		!readOnly &&
		snapshot.enabled["drawing.crop"]
	)
}

// Crop mode's life while a picture is selected, whichever tab shows: it ends with the selection on another picture
// or none, the context menu's Crop starts it, Enter or Escape in the document ends it.
export function DocxPictureCrop(props: DocxToolbarSlotProps) {
	const { execute, inputRequest, onInputDone } = props
	const pos = props.snapshot?.context.drawing?.pos ?? null
	const crop = useDrawingCrop(execute)
	const canCrop = cropPossible(props)
	const cropping = pos !== null && crop === pos
	const cropRequest = inputRequest?.type === "drawing.crop" ? inputRequest.nonce : null

	useEffect(() => {
		if (!canCrop) {
			setDrawingCrop(execute, null)
		}

		return () => {
			setDrawingCrop(execute, null)
		}
	}, [pos, canCrop, execute])

	useEffect(() => {
		if (cropRequest === null) {
			return
		}

		onInputDone(cropRequest)

		if (canCrop && pos !== null) {
			setDrawingCrop(execute, pos)
		}
	}, [cropRequest, canCrop, pos, onInputDone, execute])

	useEffect(() => {
		if (!cropping) {
			return
		}

		// Keys pressed in the document only (its pages and their input): the find field, a ribbon button, a dialog
		// or a menu over it keep their own Enter and Escape.
		const onKey = (event: KeyboardEvent): void => {
			if (!(event.target instanceof Element) || event.target.closest(".fo-docx-editor") === null) {
				return
			}

			if (event.key === "Escape" || event.key === "Enter") {
				event.preventDefault()
				event.stopPropagation()
				setDrawingCrop(execute, null)
			}
		}

		window.addEventListener("keydown", onKey, true)

		return () => {
			window.removeEventListener("keydown", onKey, true)
		}
	}, [cropping, execute])

	return null
}

export function DocxDrawingMenu(props: DocxDrawingMenuProps) {
	const { t } = useTranslation("preview")
	const { snapshot, readOnly, execute, requestInput, items } = props
	const drawing = snapshot?.context.drawing ?? null
	const pos = drawing?.pos ?? null
	const crop = useDrawingCrop(execute)
	const focus = useCommandMenuFocus()
	const off = (type: DocxEditorCommandType): boolean => snapshot === undefined || readOnly || !snapshot.enabled[type]
	const canCrop = cropPossible(props)
	const cropping = pos !== null && crop === pos

	if (drawing === null || items.length === 0) {
		return null
	}

	return (
		<>
			{items.includes("drawing.wrap") ? (
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger
							render={
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("previewDocxPictureWrap")}
											disabled={off("drawing.wrap")}
											onMouseDown={keepFocus}
										>
											<WrapTextIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("previewDocxPictureWrap")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent
						data-preview-surface
						finalFocus={focus.finalFocus}
					>
						<DropdownMenuRadioGroup value={drawing.wrap}>
							{WRAP_VARIANTS.map(variant =>
								"command" in variant && variant.command.type === "drawing.wrap" ? (
									<DropdownMenuRadioItem
										key={variant.label}
										value={variant.command.mode}
										closeOnClick
										onClick={() => {
											execute(variant.command)
											focus.ran()
										}}
									>
										{t(variant.label)}
									</DropdownMenuRadioItem>
								) : null
							)}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			{items.includes("drawing.rotate") ? (
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger
							render={
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("previewDocxPictureRotate")}
											disabled={off("drawing.rotate")}
											onMouseDown={keepFocus}
										>
											<RotateCwIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("previewDocxPictureRotate")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent
						data-preview-surface
						finalFocus={focus.finalFocus}
					>
						{ROTATE_VARIANTS.map(variant =>
							"command" in variant ? (
								<DropdownMenuItem
									key={variant.label}
									onClick={() => {
										execute(variant.command)
										focus.ran()
									}}
								>
									{t(variant.label)}
								</DropdownMenuItem>
							) : null
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			{items.includes("drawing.crop") ? (
				<TooltipIconButton
					label={t("previewDocxPictureCrop")}
					disabled={!canCrop}
					pressed={cropping}
					className={cn(cropping && "bg-accent text-foreground")}
					onMouseDown={keepFocus}
					onClick={() => {
						setDrawingCrop(execute, cropping ? null : drawing.pos)
					}}
				>
					<CropIcon />
				</TooltipIconButton>
			) : null}
			{items.includes("drawing.altText") ? (
				<TooltipIconButton
					label={t("previewDocxPictureAltText")}
					disabled={off("drawing.altText")}
					onMouseDown={keepFocus}
					onClick={() => {
						requestInput("drawing.altText")
					}}
				>
					<CaptionsIcon />
				</TooltipIconButton>
			) : null}
			{items.includes("drawing.delete") ? (
				<TooltipIconButton
					label={t("previewDocxPictureDelete")}
					disabled={off("drawing.delete")}
					onMouseDown={keepFocus}
					onClick={() => {
						execute({ type: "drawing.delete" })
					}}
				>
					<Trash2Icon />
				</TooltipIconButton>
			) : null}
		</>
	)
}
