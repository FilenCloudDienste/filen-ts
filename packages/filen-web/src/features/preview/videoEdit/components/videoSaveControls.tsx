import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, ChevronDownIcon, CopyIcon, HistoryIcon, InfoIcon, ZapIcon } from "lucide-react"
import { cn, formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type {
	ExportPlan,
	OutputQuality,
	OutputResolution,
	VideoEditRecipe,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"
import { dropNotices, etaMinutes, targetNote, type DropNotice, type EditFeature } from "@/features/preview/videoEdit/lib/availability"
import { formatTimecode } from "@/features/preview/videoEdit/lib/timeline.logic"
import type { NamespaceKey } from "@/lib/i18n"

type PreviewKey = NamespaceKey<"preview">

const RESOLUTIONS: readonly OutputResolution[] = ["original", 1080, 720, 480]
const QUALITIES: readonly { id: OutputQuality; labelKey: PreviewKey }[] = [
	{ id: "high", labelKey: "previewVideoSaveQualityHigh" },
	{ id: "medium", labelKey: "previewVideoSaveQualityMedium" },
	{ id: "low", labelKey: "previewVideoSaveQualityLow" }
]

const DROP_LABELS: Readonly<Record<DropNotice, PreviewKey>> = {
	subtitlesAndChapters: "previewVideoSaveDropSubtitlesAndChapters",
	subtitles: "previewVideoSaveDropSubtitles",
	chapters: "previewVideoSaveDropChapters",
	extraAudio: "previewVideoSaveDropExtraAudio",
	hdrMetadata: "previewVideoSaveDropHdrMetadata",
	location: "previewVideoSaveDropLocation"
}

// "about 3 min", "under a minute".
function useEtaLabel(): (seconds: number | null) => string {
	const { t } = useTranslation("preview")

	return seconds => {
		const minutes = etaMinutes(seconds)

		return minutes === 0 ? t("previewVideoSaveUnderMinute") : t("previewVideoSaveMinutes", { count: minutes })
	}
}

function OptionChip(props: { selected: boolean; disabled: boolean; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-pressed={props.selected}
			disabled={props.disabled}
			className={cn(
				"h-7 min-w-0 flex-1 rounded-full px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-40 motion-reduce:transition-none",
				props.selected ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-muted"
			)}
			onClick={props.onClick}
		>
			{props.label}
		</button>
	)
}

function Notice(props: { icon: ReactNode; tone?: "warning" | undefined; children: ReactNode }) {
	return (
		<li
			className={cn(
				"flex items-start gap-2 text-xs [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0",
				props.tone === "warning" ? "text-amber-300" : "text-muted-foreground"
			)}
		>
			{props.icon}
			<span>{props.children}</span>
		</li>
	)
}

export interface SavePopoverProps {
	plan: ExportPlan | null
	recipe: VideoEditRecipe
	info: VideoSourceInfo
	unavailable: ReadonlySet<EditFeature>
	dirty: boolean
	online: boolean
	busy: boolean
	open: boolean
	onOpenChange: (open: boolean) => void
	onOutput: (output: VideoEditRecipe["output"]) => void
	onRemoveLocation: (remove: boolean) => void
	onSave: (target: VideoSaveTarget) => void
}

// The header's Save ▾: a summary of what the save will do (fast copy or re-encode, the size and time it will take, what it
// drops, HDR, what happens to the original) with the output settings, and the ways to save the plan offers, in its
// order (the first is the primary).
export function SavePopover(props: SavePopoverProps) {
	const { t } = useTranslation(["preview", "common"])
	const eta = useEtaLabel()
	const { plan, recipe, info } = props
	const shortSide = Math.min(info.width, info.height)
	const offline = !props.online

	return (
		<Popover
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						disabled={!props.dirty || props.busy}
					>
						{t("previewVideoSaveOpen")}
						<ChevronDownIcon data-icon="inline-end" />
					</Button>
				}
			/>
			{/* Portaled outside the darkroom subtree: dark on its own. */}
			<PopoverContent
				align="end"
				className="dark w-80 scheme-dark"
			>
				{plan === null ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner className="size-4" />
						{t("previewVideoSavePlanning")}
					</div>
				) : (
					<>
						<div className="flex flex-col gap-1">
							<div className="flex items-center gap-1.5 text-sm font-medium">
								{plan.mode === "copy" ? <ZapIcon className="size-4 text-amber-300" /> : null}
								{t(plan.mode === "copy" ? "previewVideoSaveFast" : "previewVideoSaveReencode")}
							</div>
							<p className="text-xs text-muted-foreground">
								{t(plan.mode === "copy" ? "previewVideoSaveFastHint" : "previewVideoSaveReencodeHint")}
							</p>
							<p className="text-xs text-muted-foreground tabular-nums">
								{t("previewVideoSaveEstimate", { size: formatBytes(plan.estimateBytes), time: eta(plan.estimateSeconds) })}
								{" · "}
								{t("previewVideoSaveLength", { length: formatTimecode(plan.outputDuration) })}
							</p>
						</div>
						<ul className="flex flex-col gap-1.5">
							{dropNotices(plan.dropped).map(notice => (
								<Notice
									key={notice}
									icon={<InfoIcon />}
								>
									{t(DROP_LABELS[notice])}
								</Notice>
							))}
							{plan.hdr === "toSdr" ? (
								<Notice
									icon={<AlertTriangleIcon />}
									tone="warning"
								>
									{t("previewVideoSaveHdrToSdr")}
								</Notice>
							) : null}
							{targetNote(plan) === "versionKept" ? (
								<Notice icon={<HistoryIcon />}>{t("previewVideoSaveVersionKept")}</Notice>
							) : targetNote(plan) === "versioningOff" ? (
								<Notice
									icon={<AlertTriangleIcon />}
									tone="warning"
								>
									{t("previewVideoSaveVersioningOff")}
								</Notice>
							) : (
								<Notice icon={<CopyIcon />}>{t("previewVideoSaveCopyOnly")}</Notice>
							)}
						</ul>
					</>
				)}
				<div
					role="group"
					aria-label={t("previewVideoSaveResolution")}
					className="flex flex-col gap-1.5"
				>
					<span className="text-xs font-medium text-muted-foreground">{t("previewVideoSaveResolution")}</span>
					<div className="flex gap-0.5 rounded-full bg-canvas p-1">
						{RESOLUTIONS.map(resolution => (
							<OptionChip
								key={resolution}
								selected={recipe.output.resolution === resolution}
								disabled={
									props.busy ||
									(resolution !== "original" && (props.unavailable.has("resize") || resolution >= shortSide))
								}
								label={resolution === "original" ? t("previewVideoSaveResolutionOriginal") : `${String(resolution)}p`}
								onClick={() => {
									props.onOutput({ ...recipe.output, resolution })
								}}
							/>
						))}
					</div>
				</div>
				<div
					role="group"
					aria-label={t("previewVideoSaveQuality")}
					className="flex flex-col gap-1.5"
				>
					<span className="text-xs font-medium text-muted-foreground">{t("previewVideoSaveQuality")}</span>
					<div className="flex gap-0.5 rounded-full bg-canvas p-1">
						{QUALITIES.map(quality => (
							<OptionChip
								key={quality.id}
								selected={recipe.output.quality === quality.id}
								disabled={props.busy || props.unavailable.has("quality")}
								label={t(quality.labelKey)}
								onClick={() => {
									props.onOutput({ ...recipe.output, quality: quality.id })
								}}
							/>
						))}
					</div>
				</div>
				{info.hasLocation ? (
					<label className="flex items-center justify-between gap-3 text-sm">
						<span>{t("previewVideoSaveRemoveLocation")}</span>
						<Switch
							checked={recipe.removeLocation}
							disabled={props.busy}
							onCheckedChange={props.onRemoveLocation}
						/>
					</label>
				) : null}
				{offline ? <p className="text-xs text-muted-foreground">{t("common:offlineActionDisabled")}</p> : null}
				<div className="flex flex-wrap justify-end gap-2">
					{(plan?.targets ?? []).map((target, index) => (
						<Button
							key={target}
							size="sm"
							variant={index === 0 ? "default" : "outline"}
							autoFocus={index === 0}
							disabled={plan === null || offline || props.busy || !props.dirty}
							onClick={() => {
								props.onSave(target)
							}}
						>
							{t(target === "inPlace" ? "previewVideoSaveInPlace" : "previewVideoSaveAsCopy")}
						</Button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	)
}

export type ExportState = { status: "running"; fraction: number; etaSeconds: number | null } | { status: "failed"; message: string }

// The export's progress under the header while it runs in the editor, or its failure with Retry (the edits stay).
export function ExportBar(props: {
	state: ExportState
	onBackground: () => void
	onCancel: () => void
	onRetry: () => void
	onDismiss: () => void
}) {
	const { t } = useTranslation("preview")
	const eta = useEtaLabel()
	const state = props.state

	if (state.status === "failed") {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm"
			>
				<AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					{t("previewVideoSaveFailed")}
					{state.message.length > 0 ? <span className="ml-1 text-muted-foreground">{state.message}</span> : null}
				</span>
				<Button
					size="sm"
					variant="ghost"
					onClick={props.onDismiss}
				>
					{t("previewVideoSaveDismiss")}
				</Button>
				<Button
					size="sm"
					onClick={props.onRetry}
				>
					{t("previewVideoSaveRetry")}
				</Button>
			</div>
		)
	}

	const percent = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100)

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
			<div className="flex min-w-48 flex-1 flex-col gap-1.5">
				<span
					className="text-sm tabular-nums"
					aria-live="polite"
				>
					{t("previewVideoSaveExporting", { percent })}
					{state.etaSeconds !== null ? <span className="text-muted-foreground"> · {eta(state.etaSeconds)}</span> : null}
				</span>
				<Progress
					value={percent}
					aria-label={t("previewVideoSaveExporting", { percent })}
				/>
			</div>
			<Button
				size="sm"
				variant="secondary"
				onClick={props.onBackground}
			>
				{t("previewVideoSaveContinueInBackground")}
			</Button>
			<Button
				size="sm"
				variant="ghost"
				aria-label={t("previewVideoSaveCancelExportLabel")}
				onClick={props.onCancel}
			>
				{t("previewVideoSaveCancelExport")}
			</Button>
		</div>
	)
}
