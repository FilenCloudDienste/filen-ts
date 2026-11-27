import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import * as Comlink from "comlink"
import {
	ChevronDownIcon,
	ContrastIcon,
	ImageIcon,
	ListTreeIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	SkipBackIcon,
	SkipForwardIcon
} from "lucide-react"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { isImeKeydown } from "@filen/shared/keymap"
import type { DriveItem } from "@/features/drive/lib/item"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { Slider } from "@/components/ui/slider"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { originRanged, originSize } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { useOwnedWorker, type OwnedWorker } from "@/lib/workers/ownedWorker"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { workerDecodeBytes } from "@/lib/pixelBudget"
import { syncRangeSlots } from "@/lib/media/syncRange"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { useLatestRef } from "@/lib/useLatestRef"
import { usePreviewAccessMode, usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { openOriginSyncSource } from "@/features/preview/lib/origin/syncSource"
import { CanvasViewerShell } from "@/features/preview/components/canvasViewerShell"
import { DicomTagTree } from "@/features/preview/components/dicomTagTree"
import { PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { DICOM_WHOLE_MAX_BYTES } from "@/features/preview/lib/dicom/transferSyntax"
import { dicomViewerKey, stepFrame } from "@/features/preview/lib/dicom/keys.logic"
import type { DicomInfo, DicomOpenFailure, DicomOpenResult, DicomStatus, FrameFailure } from "@/features/preview/lib/dicom/protocol"
import {
	frameRequester,
	presetOf,
	windowFigure,
	windowPresets,
	type CtPreset,
	type WindowPresetEntry
} from "@/features/preview/components/dicomViewer.logic"
import DicomWorker from "@/features/preview/workers/dicom.worker.ts?worker"
import type { DicomWorkerApi } from "@/features/preview/workers/dicom.worker"

type DicomWorkerHandle = OwnedWorker<DicomWorkerApi>

type OpenState = { status: "opening" } | { status: "open"; info: DicomInfo } | { status: "failed"; reason: DicomOpenFailure }

function createDicomWorker(): Worker {
	return new DicomWorker()
}

const OPEN_MESSAGES = {
	notDicom: "previewDicomNotDicom",
	damaged: "previewDicomDamaged",
	tooLarge: "previewDicomTooLarge",
	unreadable: "previewDicomUnreadable"
} as const

const IMAGE_MESSAGES = {
	noImage: "previewDicomNoImage",
	unsupported: "previewDicomUnsupported",
	damaged: "previewDicomDamaged",
	tooLarge: "previewDicomTooLarge"
} as const

const FRAME_MESSAGES = {
	tooLarge: "previewDicomFrameTooLarge",
	damaged: "previewDicomFrameFailed",
	mismatch: "previewDicomFrameMismatch",
	unsupported: "previewDicomUnsupported",
	unreadable: "previewDicomFrameFailed"
} as const satisfies Record<FrameFailure, string>

// Opens the file in the viewer's worker once it is up: a drive or link file through the sync range bridge (its header
// and frames read as they are needed), anything else read whole first. The bridge and any download end with the viewer.
function useDicomOpen(item: DriveItem, owned: DicomWorkerHandle | null): { state: OpenState; retry: () => void } {
	const origin = usePreviewOrigin(item)
	const access = usePreviewAccessMode()
	const profile = useDeviceProfile()
	// Kept with the worker it was read from: a new worker (Reload, a restart) is opening until its own open resolved.
	const [opened, setOpened] = useState<{ owned: DicomWorkerHandle | null; state: OpenState }>({
		owned: null,
		state: { status: "opening" }
	})
	const [attempt, setAttempt] = useState(0)
	const readOrigin = useRef(origin)
	const decodeBytes = workerDecodeBytes(profile)
	// Read when the file opens; a profile refined after that reaches the worker without opening (or downloading) it again.
	const budgetBytes = useLatestRef(decodeBytes)

	useEffect(() => {
		if (owned !== null) void owned.run(remote => remote.setBudget({ decodeBytes })).catch(() => undefined)
	}, [owned, decodeBytes])

	useEffect(() => {
		if (owned === null) {
			return
		}

		let live = true
		let close = (): void => undefined
		const token = crypto.randomUUID()
		const reads = new AbortController()
		const from = readOrigin.current
		// Read as the file is sent, so a profile refined while it was being fetched is the one it opens with.
		const budget = (): { decodeBytes: number } => ({ decodeBytes: budgetBytes.current })
		const open = async (): Promise<DicomOpenResult> => {
			if (originRanged(from)) {
				const bridge = await openOriginSyncSource(from, token, { access })

				// The viewer went while the bridge opened: nothing will close it but this.
				if (!live) {
					bridge.close()

					throw new Error("the viewer closed before its file opened")
				}

				close = () => {
					bridge.close()
				}

				return await owned.run(remote =>
					remote.open(
						Comlink.transfer({ kind: "ranged", channel: bridge.channel, ringBytes: syncRangeSlots() * BLOCK_BYTES }, [
							bridge.channel.port
						]),
						budget()
					)
				)
			}

			if (originSize(from) > DICOM_WHOLE_MAX_BYTES) {
				return { info: null, failure: "tooLarge" }
			}

			const bytes = await loadOriginBytes(from, token, { access, cap: DICOM_WHOLE_MAX_BYTES, store: false, signal: reads.signal })

			return await owned.run(remote => remote.open(Comlink.transfer({ kind: "whole", bytes }, [bytes.buffer]), budget()))
		}

		open().then(
			result => {
				if (!live) return

				setOpened({
					owned,
					state:
						result.info !== null
							? { status: "open", info: result.info }
							: { status: "failed", reason: result.failure ?? "damaged" }
				})
			},
			() => {
				if (live) setOpened({ owned, state: { status: "failed", reason: "unreadable" } })
			}
		)

		return () => {
			live = false
			reads.abort()
			close()
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [owned, access, budgetBytes, attempt])

	return {
		state: opened.owned !== null && opened.owned === owned ? opened.state : { status: "opening" },
		retry: () => {
			setOpened({ owned, state: { status: "opening" } })
			setAttempt(previous => previous + 1)
		}
	}
}

const CT_PRESET_LABELS = {
	softTissue: "previewDicomPresetSoftTissue",
	lung: "previewDicomPresetLung",
	bone: "previewDicomPresetBone",
	brain: "previewDicomPresetBrain",
	liver: "previewDicomPresetLiver",
	mediastinum: "previewDicomPresetMediastinum"
} as const satisfies Record<CtPreset, string>

function presetLabel(entry: WindowPresetEntry | null, t: TFunction<"preview">): string {
	if (entry === null) return t("previewDicomPresetCustom")

	switch (entry.kind) {
		case "default":
			return t("previewDicomPresetDefault")
		case "file":
			return entry.explanation ?? t("previewDicomPresetFile", { number: entry.index })
		case "ct":
			return t(CT_PRESET_LABELS[entry.id])
	}
}

function Summary({ info }: { info: DicomInfo }) {
	const { t } = useTranslation("preview")
	const parts = [
		...(info.modality === null ? [] : [info.modality]),
		t("previewDicomSize", { columns: info.columns, rows: info.rows }),
		...(info.frames > 1 ? [t("previewDicomFrames", { count: info.frames })] : [])
	]

	return <p className="truncate px-4 pt-3 pb-2 text-sm text-muted-foreground">{parts.join(" · ")}</p>
}

function Scrubber({
	info,
	status,
	onFrame,
	onPlay
}: {
	info: DicomInfo
	status: DicomStatus
	onFrame: (frame: number) => void
	onPlay: (on: boolean) => void
}) {
	const { t } = useTranslation("preview")
	const last = info.frames - 1

	return (
		<div className="flex w-[min(36rem,calc(100cqw-4rem))] items-center gap-1">
			<TooltipIconButton
				label={t("previewDicomPreviousFrame")}
				shortcut={<Kbd action="preview.dicomPreviousFrame" />}
				disabled={status.frame <= 0}
				onClick={() => {
					onFrame(status.frame - 1)
				}}
			>
				<SkipBackIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewDicomNextFrame")}
				shortcut={<Kbd action="preview.dicomNextFrame" />}
				disabled={status.frame >= last}
				onClick={() => {
					onFrame(status.frame + 1)
				}}
			>
				<SkipForwardIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={t(status.playing ? "previewDicomPause" : "previewDicomPlay")}
				pressed={status.playing}
				onClick={() => {
					onPlay(!status.playing)
				}}
			>
				{status.playing ? <PauseIcon /> : <PlayIcon />}
			</TooltipIconButton>
			<Slider
				aria-label={t("previewDicomFrameSlider")}
				className="mx-2 min-w-0 flex-1"
				min={0}
				max={last}
				step={1}
				value={status.frame}
				getAriaValueText={() => t("previewDicomFrame", { frame: status.frame + 1, count: info.frames })}
				onValueChange={next => {
					const frame = typeof next === "number" ? next : next[0]

					if (frame !== undefined) onFrame(frame)
				}}
			/>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
				{t("previewDicomFrame", { frame: status.frame + 1, count: info.frames })}
			</span>
		</div>
	)
}

function WindowPresets({ info, status, owned }: { info: DicomInfo; status: DicomStatus; owned: DicomWorkerHandle }) {
	const { t } = useTranslation("preview")
	const presets = windowPresets(info)
	const selected = presetOf(presets, status.window, status.atDefault)

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
					/>
				}
			>
				{t("previewDicomPreset", { preset: presetLabel(selected, t) })}
				<ChevronDownIcon data-icon="inline-end" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="center">
				{presets.map(entry => (
					<DropdownMenuItem
						key={entry.kind === "ct" ? entry.id : entry.kind === "file" ? `file-${String(entry.index)}` : "default"}
						onClick={() => {
							void owned
								.run(remote =>
									remote.setWindow(entry.kind === "default" ? null : { center: entry.center, width: entry.width })
								)
								.catch(() => undefined)
						}}
					>
						{presetLabel(entry, t)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The image on the shell's canvas: the summary above, the window readout over it, the presets, Invert, Reset and Tags
// below, and for a multi-frame image the frame scrubber with playback. Page Down and Page Up step frames.
function DicomImage({
	item,
	info,
	owned,
	generation,
	onReload
}: {
	item: DriveItem
	info: DicomInfo
	owned: DicomWorkerHandle
	generation: number
	onReload: () => void
}) {
	const { t } = useTranslation("preview")
	const [status, setStatus] = useState<DicomStatus>({
		frame: 0,
		window: null,
		atDefault: true,
		playing: false,
		failure: null,
		reduced: false
	})
	const [invert, setInvert] = useState(false)
	const [tags, setTags] = useState(false)
	// A single frame that could not be shown: its card, or the file's tags from it.
	const [tagsOnly, setTagsOnly] = useState(false)
	const hostRef = useRef<HTMLDivElement>(null)
	const [request] = useState(() =>
		frameRequester(
			frame => owned.run(remote => remote.show(frame)),
			() => undefined
		)
	)
	const bindings = useBindings()
	const latest = useLatestRef({ status, bindings, frames: info.frames, request })

	useEffect(() => {
		request(0)
	}, [request])

	// Page Down and Page Up for the preview layer this image is in, ahead of the overlay's own keys.
	useEffect(() => {
		const listener = (event: KeyboardEvent): void => {
			const host = hostRef.current
			const { status: now, bindings: combos, frames, request: show } = latest.current

			if (
				host === null ||
				frames < 2 ||
				event.defaultPrevented ||
				isImeKeydown(event) ||
				isRecordingCombo() ||
				!keyForEditor(host, event.target)
			) {
				return
			}

			const action = dicomViewerKey(event, combos)

			if (action === undefined) return

			event.preventDefault()
			show(stepFrame(now.frame, frames, action))
		}

		document.addEventListener("keydown", listener, true)

		return () => {
			document.removeEventListener("keydown", listener, true)
		}
	}, [latest])

	if (info.frames === 1 && status.failure !== null) {
		if (tagsOnly) {
			return (
				<TagsOnly
					owned={owned}
					onBack={() => {
						setTagsOnly(false)
					}}
				/>
			)
		}

		return (
			<PreviewUnsupportedState
				item={item}
				message={t(FRAME_MESSAGES[status.failure])}
				secondary={
					<TagsButton
						onClick={() => {
							setTagsOnly(true)
						}}
					/>
				}
			/>
		)
	}

	const showFrame = (frame: number): void => {
		request(Math.min(info.frames - 1, Math.max(0, frame)))
	}

	return (
		<div
			ref={hostRef}
			className="flex size-full min-h-0 flex-col"
		>
			<Summary info={info} />
			<div className="relative min-h-0 flex-1">
				<CanvasViewerShell<DicomStatus>
					item={item}
					session={generation}
					label={t("previewDicomCanvasLabel")}
					connect={port => {
						void owned.run(remote => remote.attach(Comlink.transfer(port, [port])))
					}}
					onStatus={setStatus}
					onReload={onReload}
					notice={
						status.failure !== null || status.reduced ? (
							<span className="rounded-md bg-background/80 px-2 py-1 text-muted-foreground">
								{t(status.failure === null ? "previewDicomReduced" : FRAME_MESSAGES[status.failure])}
							</span>
						) : undefined
					}
					sidePanel={
						tags ? (
							<DicomTagTree
								load={path => owned.run(remote => remote.tags(path))}
								loadValue={path => owned.run(remote => remote.tagValue(path))}
							/>
						) : undefined
					}
					toolbar={
						<div className="flex flex-col items-center gap-1 rounded-xl bg-background/80 p-1 shadow-sm">
							{info.frames > 1 ? (
								<Scrubber
									info={info}
									status={status}
									onFrame={showFrame}
									onPlay={on => {
										void owned.run(remote => remote.play(on)).catch(() => undefined)
									}}
								/>
							) : null}
							<div className="flex flex-wrap justify-center gap-1">
								{info.windowed ? (
									<WindowPresets
										info={info}
										status={status}
										owned={owned}
									/>
								) : null}
								<Button
									variant="ghost"
									size="sm"
									aria-pressed={invert}
									onClick={() => {
										setInvert(!invert)
										void owned.run(remote => remote.setInvert(!invert)).catch(() => undefined)
									}}
								>
									<ContrastIcon data-icon="inline-start" />
									{t("previewDicomInvert")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setInvert(false)
										void owned.run(remote => remote.reset()).catch(() => undefined)
									}}
								>
									<RotateCcwIcon data-icon="inline-start" />
									{t("previewDicomReset")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-pressed={tags}
									onClick={() => {
										setTags(!tags)
									}}
								>
									<ListTreeIcon data-icon="inline-start" />
									{t("previewDicomTags")}
								</Button>
							</div>
						</div>
					}
				/>
				{info.windowed && status.window !== null && status.failure === null ? (
					<span className="pointer-events-none absolute top-2 right-3 rounded-md bg-background/70 px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
						{t("previewDicomWindowReadout", {
							width: windowFigure(status.window.width),
							center: windowFigure(status.window.center)
						})}
					</span>
				) : null}
			</div>
		</div>
	)
}

// A card's way to the file's tags.
function TagsButton({ onClick }: { onClick: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<Button
			variant="outline"
			onClick={onClick}
		>
			<ListTreeIcon data-icon="inline-start" />
			{t("previewDicomTags")}
		</Button>
	)
}

// The file's tags in full, for a file whose image is not shown: the card's Tags button opens them.
function TagsOnly({ owned, onBack }: { owned: DicomWorkerHandle; onBack: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex size-full min-h-0 flex-col">
			<div className="flex shrink-0 justify-end px-3 py-2">
				<Button
					variant="outline"
					size="sm"
					onClick={onBack}
				>
					<ImageIcon data-icon="inline-start" />
					{t("previewDicomShowImage")}
				</Button>
			</div>
			<div className="min-h-0 flex-1">
				<DicomTagTree
					load={path => owned.run(remote => remote.tags(path))}
					loadValue={path => owned.run(remote => remote.tagValue(path))}
				/>
			</div>
		</div>
	)
}

// A DICOM file (dcm, dicom): its image drawn in its own worker, frame by frame, through the window (presets for CT, a
// drag for any grey image), the file's tags in a panel. A drive or link file is read in ranges at any size: only its
// header and the frames shown are downloaded.
export function DicomViewer({ item }: { item: DriveItem }) {
	const { t } = useTranslation(["preview", "common"])
	const [attempt, setAttempt] = useState(0)
	const worker = useOwnedWorker<DicomWorkerApi>(createDicomWorker, `${item.data.uuid}:${String(attempt)}`, "dicom")
	const owned = worker.status === "ready" ? worker.owned : null
	const generation = worker.status === "ready" ? worker.generation : 0
	const { state, retry } = useDicomOpen(item, owned)
	const [tagsOnly, setTagsOnly] = useState(false)

	if (worker.status === "failed" || state.status === "failed") {
		const reason = state.status === "failed" ? state.reason : "unreadable"

		return (
			<PreviewUnsupportedState
				item={item}
				message={t(OPEN_MESSAGES[reason])}
				secondary={
					reason === "unreadable" ? (
						<Button
							variant="outline"
							onClick={() => {
								if (worker.status === "failed") worker.restart()
								else retry()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					) : undefined
				}
			/>
		)
	}

	if (state.status !== "open" || owned === null) {
		return <PreviewLoading />
	}

	const { info } = state

	if (info.image !== "ok") {
		if (tagsOnly) {
			return (
				<TagsOnly
					owned={owned}
					onBack={() => {
						setTagsOnly(false)
					}}
				/>
			)
		}

		return (
			<PreviewUnsupportedState
				item={item}
				message={t(IMAGE_MESSAGES[info.image])}
				secondary={
					<TagsButton
						onClick={() => {
							setTagsOnly(true)
						}}
					/>
				}
			/>
		)
	}

	return (
		<DicomImage
			key={generation}
			item={item}
			info={info}
			owned={owned}
			generation={generation}
			onReload={() => {
				setAttempt(previous => previous + 1)
			}}
		/>
	)
}
