import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
	EyeOffIcon,
	ImageIcon,
	MaximizeIcon,
	RepeatIcon,
	Volume1Icon,
	Volume2Icon,
	VolumeIcon,
	VolumeXIcon,
	type LucideIcon
} from "lucide-react"
import type { MediaPlayback, SlideMediaInfo, ShapeRef } from "@filen/office/core/presentation"
import { selectedShapes, useShapeSelection } from "@filen/office/react/presentation"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import type {
	PresentationGroups,
	PresentationRibbonContext,
	PresentationRibbonEditor
} from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Video tab (and, through mediaPlaybackGroups, the Audio tab): how the selected medium plays in the show —
// volume, hidden while not playing, looping, full screen (video) — written to the slide's timing as one op each, and
// a video's poster frame from a picture on this device.

type MediaKind = SlideMediaInfo["kind"]

const POSTER_MAX = 1280

// The selected medium of `kind` on the slide in view (exactly one shape selected).
function useSelectedMedia(
	editor: PresentationRibbonEditor,
	kind: MediaKind
): { readonly target: ShapeRef; readonly media: SlideMediaInfo } | undefined {
	const state = useShapeSelection(editor.selection)
	const render = editor.render
	const selected = selectedShapes(render, state)
	const only = selected.length === 1 ? selected[0] : undefined
	const layer =
		only === undefined ? undefined : render?.layers.find(candidate => candidate.box?.id === only.id && candidate.media !== undefined)

	if (render === undefined || only === undefined || layer?.media?.kind !== kind) return undefined

	return { target: { slide: render.ref, id: only.id }, media: layer.media }
}

const VOLUMES: readonly {
	readonly value: string
	readonly label: PreviewKey
	readonly icon: LucideIcon
	readonly playback: MediaPlayback
}[] = [
	{ value: "low", label: "previewPptxMediaVolumeLow", icon: VolumeIcon, playback: { volume: 25_000, mute: false } },
	{ value: "medium", label: "previewPptxMediaVolumeMedium", icon: Volume1Icon, playback: { volume: 50_000, mute: false } },
	{ value: "high", label: "previewPptxMediaVolumeHigh", icon: Volume2Icon, playback: { volume: 100_000, mute: false } },
	{ value: "mute", label: "previewPptxMediaVolumeMute", icon: VolumeXIcon, playback: { mute: true } }
]

function volumeOf(playback: MediaPlayback | undefined): string {
	if (playback?.mute === true) return "mute"

	const volume = playback?.volume ?? 100_000

	return volume <= 37_500 ? "low" : volume <= 75_000 ? "medium" : "high"
}

function PlaybackControls({ editor, kind }: { editor: PresentationRibbonEditor; kind: MediaKind }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const selected = useSelectedMedia(editor, kind)
	const playback = selected?.media.playback
	const disabled = selected === undefined || !editor.info.editable
	const set = (next: MediaPlayback): void => {
		if (selected !== undefined) void editor.command({ family: "media", kind: "setPlayback", target: selected.target, playback: next })
	}
	const volume = volumeOf(playback)
	const VolumeNow = VOLUMES.find(item => item.value === volume)?.icon ?? Volume2Icon

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxMediaVolume")}
					text={t("previewPptxMediaVolume")}
					icon={<VolumeNow />}
					disabled={disabled}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuRadioGroup
						value={volume}
						onValueChange={value => {
							focus.ran()

							const item = VOLUMES.find(candidate => candidate.value === value)

							if (item !== undefined) set(item.playback)
						}}
					>
						{VOLUMES.map(item => (
							<DropdownMenuRadioItem
								key={item.value}
								value={item.value}
							>
								{t(item.label)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<RibbonButton
				label={t("previewPptxMediaHideWhenStopped")}
				icon={<EyeOffIcon />}
				pressed={playback?.hideWhenStopped === true}
				disabled={disabled}
				onClick={() => {
					set({ hideWhenStopped: playback?.hideWhenStopped !== true })
				}}
			/>
			<RibbonButton
				label={t("previewPptxMediaLoop")}
				icon={<RepeatIcon />}
				pressed={playback?.loop === true}
				disabled={disabled}
				onClick={() => {
					set({ loop: playback?.loop !== true })
				}}
			/>
			{kind === "video" ? (
				<RibbonButton
					label={t("previewPptxMediaFullScreen")}
					icon={<MaximizeIcon />}
					pressed={playback?.fullScreen === true}
					disabled={disabled}
					onClick={() => {
						set({ fullScreen: playback?.fullScreen !== true })
					}}
				/>
			) : null}
		</>
	)
}

// A picture from this device as the poster: drawn at most POSTER_MAX px on its longest side (PNG keeps its alpha).
async function posterFrom(
	file: File
): Promise<{ bytes: Uint8Array; contentType: "image/png" | "image/jpeg"; width: number; height: number }> {
	const bitmap = await createImageBitmap(file)

	try {
		const scale = Math.min(1, POSTER_MAX / Math.max(bitmap.width, bitmap.height))
		const canvas = document.createElement("canvas")

		canvas.width = Math.max(1, Math.round(bitmap.width * scale))
		canvas.height = Math.max(1, Math.round(bitmap.height * scale))
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

		const contentType = file.type === "image/png" ? "image/png" : "image/jpeg"
		const blob = await new Promise<Blob | null>(resolve => {
			canvas.toBlob(resolve, contentType, 0.85)
		})

		if (blob === null) throw new Error("the poster could not be encoded")

		return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType, width: canvas.width, height: canvas.height }
	} finally {
		bitmap.close()
	}
}

// Opens the file chooser for a poster image. The input is the chooser's own, not the control's: a command run from the
// ribbon's overflow closes it, and the control with it, while the chooser is still open.
export function choosePoster(onFile: (file: File) => void): void {
	const input = document.createElement("input")

	input.type = "file"
	input.accept = "image/png,image/jpeg,image/webp,image/gif"
	input.addEventListener(
		"change",
		() => {
			const file = input.files?.[0]

			if (file !== undefined) onFile(file)
		},
		{ once: true }
	)
	input.click()
}

function PosterControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const selected = useSelectedMedia(editor, "video")

	return (
		<RibbonButton
			label={t("previewPptxPosterFromFile")}
			text={t("previewPptxPosterFromFile")}
			icon={<ImageIcon />}
			disabled={selected === undefined || !editor.info.editable}
			onClick={() => {
				if (selected === undefined) return

				const target = selected.target

				choosePoster(file => {
					void posterFrom(file)
						.then(poster => editor.command({ family: "media", kind: "setPoster", target, poster }))
						.catch(() => {
							toast.error(t("previewPptxPosterFailed"))
						})
				})
			}}
		/>
	)
}

// The Playback group of the Video or Audio tab (and the Video tab's Poster frame group).
export function mediaPlaybackGroups(kind: MediaKind, context: PresentationRibbonContext): ReturnType<PresentationGroups> {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: `${kind}Playback`,
			label: context.t("previewPptxPlaybackGroup", { ns: "preview" }),
			icon: Volume2Icon,
			width: kind === "video" ? 196 : 162,
			priority: 3,
			content: (
				<PlaybackControls
					editor={editor}
					kind={kind}
				/>
			)
		},
		...(kind === "video"
			? [
					{
						id: "videoPoster",
						label: context.t("previewPptxPosterGroup", { ns: "preview" }),
						icon: ImageIcon,
						width: 150,
						priority: 2,
						single: true,
						content: <PosterControls editor={editor} />
					}
				]
			: [])
	]
}

export const videoGroups: PresentationGroups = context => mediaPlaybackGroups("video", context)
