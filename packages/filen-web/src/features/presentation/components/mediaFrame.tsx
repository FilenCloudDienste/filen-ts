import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { PauseIcon, PlayIcon } from "lucide-react"
import type { SlideLayer, SlideMediaInfo, SlideRender } from "@filen/office/core/presentation"
import type { PresentationNotice, PresentationSessionApi } from "@filen/office/dom/presentation"
import {
	showMediaMount,
	type PresentationActionActivator,
	type ShowMediaHandle,
	type ShowMediaStatus
} from "@filen/office/react/presentation"
import { Button } from "@/components/ui/button"
import { mediaStreams, preparingProgress, showMediaLabels } from "@/features/presentation/hooks/useMediaInsert"

// Video and audio on the slide in view, in the viewer and the editor: a play control over each medium (the medium
// itself mounts only once played, over its poster), through the same player the show uses
// (hooks/useMediaInsert.tsx mediaStreams: the bytes by range from the deck's worker, the remux fallback, links
// through the deck's activator).

function layerTransform(layer: SlideLayer): string {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = layer.matrix

	return `matrix(${String(a)},${String(b)},${String(c)},${String(d)},${String(e)},${String(f)})`
}

function MediaFrame({
	layer,
	media,
	session,
	actions,
	progress,
	name,
	scale,
	controlsHost
}: {
	layer: SlideLayer
	media: SlideMediaInfo
	session: PresentationSessionApi
	actions: PresentationActionActivator | undefined
	progress: number | undefined
	name: string
	scale: number
	controlsHost: HTMLElement | null | undefined
}) {
	const { t } = useTranslation("preview")
	const boxRef = useRef<HTMLDivElement | null>(null)
	const handleRef = useRef<ShowMediaHandle | null>(null)
	const [status, setStatus] = useState<ShowMediaStatus>(media.part === undefined ? "linked" : "idle")
	const mountHere = (box: HTMLDivElement): ShowMediaHandle =>
		showMediaMount(mediaStreams(actions, layer.shape), {
			labels: showMediaLabels(t),
			hoverControls: false,
			onStatus: (_shape, next) => {
				setStatus(next)
			}
		}).mount(box, layer, session, { ended: () => undefined, bookmark: () => undefined })

	useEffect(
		() => () => {
			handleRef.current?.release()
			handleRef.current = null
		},
		[]
	)

	// A preparation that finished: the play the user asked for goes on.
	useEffect(() => {
		if (progress === 1 && status === "preparing") handleRef.current?.command({ command: "play" })
	}, [progress, status])

	const toggle = (): void => {
		const box = boxRef.current

		if (box === null) return

		handleRef.current ??= mountHere(box)
		handleRef.current.click()
	}
	const playing = status === "playing" || status === "loading"
	const chip =
		status === "preparing"
			? progress === undefined || progress >= 1
				? t("previewPptxMediaPreparingStart")
				: t("previewPptxMediaPreparing", { percent: Math.floor(progress * 100) })
			: undefined

	return (
		<div
			className="pointer-events-none absolute top-0 left-0 origin-top-left"
			style={{ width: layer.drawing.width, height: layer.drawing.height, transform: layerTransform(layer) }}
		>
			<div
				ref={element => {
					boxRef.current = element

					// A linked medium shows its link at once (nothing is fetched); any other mounts when first played.
					if (element !== null && media.part === undefined && handleRef.current === null) handleRef.current = mountHere(element)
				}}
				className="absolute inset-0"
				data-fo-media-box=""
			/>
			{status === "linked" ? null : (
				<Placed
					host={controlsHost}
					layer={layer}
					scale={scale}
				>
					<div className="pointer-events-auto absolute bottom-1 left-1 flex items-center gap-1">
						<Button
							variant="secondary"
							size="icon-sm"
							className="shadow-md"
							aria-label={playing ? t("previewPptxMediaPauseNamed", { name }) : t("previewPptxMediaPlayNamed", { name })}
							onPointerDown={event => {
								// The selection layer below must not take the press.
								event.stopPropagation()
							}}
							onClick={event => {
								event.stopPropagation()
								toggle()
							}}
						>
							{playing ? <PauseIcon /> : <PlayIcon />}
						</Button>
						{chip === undefined ? null : (
							<span
								role="status"
								className="rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
							>
								{chip}
							</span>
						)}
					</div>
				</Placed>
			)}
		</div>
	)
}

// The play control where it is pressed: in place over the medium, or (in the editor) in the host above the selection
// layer, laid over the same box, so a mouse reaches it while presses beside it still select.
function Placed({
	host,
	layer,
	scale,
	children
}: {
	host: HTMLElement | null | undefined
	layer: SlideLayer
	scale: number
	children: ReactNode
}) {
	if (host === undefined || host === null) return children

	return createPortal(
		<div
			className="pointer-events-none absolute top-0 left-0 origin-top-left"
			style={{ transform: `scale(${String(scale)})` }}
		>
			<div
				className="pointer-events-none absolute top-0 left-0 origin-top-left"
				style={{ width: layer.drawing.width, height: layer.drawing.height, transform: layerTransform(layer) }}
			>
				{children}
			</div>
		</div>,
		host
	)
}

// The play controls over the media of the slide in view, for SlideView's overlay slot (screen px; `scale` screen px
// per slide px). `notices`: the deck's, whose "preparing" ones carry a deflated medium's progress.
export function PresentationMediaFrames({
	render,
	session,
	scale,
	notices,
	actions,
	controlsHost
}: {
	render: SlideRender | undefined
	session: PresentationSessionApi | undefined
	scale: number
	notices: readonly PresentationNotice[]
	actions?: PresentationActionActivator
	// Where the play controls go (the editor: a layer above its selection layer); in place when absent.
	controlsHost?: HTMLElement | null
}) {
	const { t } = useTranslation("preview")
	const media = render?.layers.flatMap(layer => (layer.media === undefined ? [] : [{ layer, media: layer.media }])) ?? []

	if (render === undefined || session === undefined || media.length === 0 || scale <= 0) return null

	return (
		<div
			className="pointer-events-none absolute top-0 left-0 origin-top-left"
			style={{ transform: `scale(${String(scale)})` }}
		>
			{media.map(({ layer, media: medium }) => (
				<MediaFrame
					key={`${String(render.ref)}:${String(layer.shape.slide)}:${String(layer.shape.id)}:${medium.part ?? ""}`}
					layer={layer}
					media={medium}
					session={session}
					actions={actions}
					progress={preparingProgress(notices, medium.part)}
					scale={scale}
					controlsHost={controlsHost}
					name={layer.alt ?? t(medium.kind === "audio" ? "previewPptxInsertAudio" : "previewPptxInsertVideo")}
				/>
			))}
		</div>
	)
}
