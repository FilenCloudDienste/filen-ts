import { useTranslation } from "react-i18next"
import { FilmIcon, HardDriveIcon, MonitorSmartphoneIcon, Music2Icon } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { useSlideInView } from "@/features/presentation/components/ribbon/insertObjects"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { useMediaInsert, type MediaInsertControls, type MediaKind } from "@/features/presentation/hooks/useMediaInsert"

// Insert ▸ Media: a video or an audio clip from this device or from the drive, onto the slide in view.

function MediaMenu({ kind, controls, disabled }: { kind: MediaKind; controls: MediaInsertControls; disabled: boolean }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const Icon = kind === "video" ? FilmIcon : Music2Icon
	const label = t(kind === "video" ? "previewPptxInsertVideo" : "previewPptxInsertAudio")

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={label}
				text={label}
				icon={<Icon />}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
			>
				<DropdownMenuItem
					onClick={() => {
						focus.ran()
						controls.fromDevice(kind)
					}}
				>
					<MonitorSmartphoneIcon />
					{t("previewPptxMediaFromDevice")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						focus.ran()
						controls.fromDrive(kind)
					}}
				>
					<HardDriveIcon />
					{t("previewPptxMediaFromDrive")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function InsertMediaControls({ editor }: { editor: PresentationRibbonEditor }) {
	const controls = useMediaInsert(editor)
	// Onto the slide in view, centred, with or without a selection (as PowerPoint inserts media).
	const disabled = useSlideInView(editor) === undefined || !editor.info.editable

	return (
		<>
			<MediaMenu
				kind="video"
				controls={controls}
				disabled={disabled}
			/>
			<MediaMenu
				kind="audio"
				controls={controls}
				disabled={disabled}
			/>
			{controls.elements}
		</>
	)
}

export const insertMediaGroups: PresentationGroups = context => {
	const editor = context.editor

	return context.editable && editor !== undefined
		? [
				{
					id: "media",
					label: context.t("previewPptxMediaGroup", { ns: "preview" }),
					icon: FilmIcon,
					width: 168,
					priority: 2,
					content: <InsertMediaControls editor={editor} />
				}
			]
		: []
}
