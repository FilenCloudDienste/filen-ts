import { useEffect, useRef, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, ChevronDownIcon, CopyIcon, HistoryIcon, InfoIcon, VolumeXIcon, ZapIcon } from "lucide-react"
import { cn, formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type {
	OutputQuality,
	OutputResolution,
	VideoEditRecipe,
	VideoSaveRefusal,
	VideoSaveTarget,
	VideoSourceInfo
} from "@/features/preview/videoEdit/types"
import {
	announcedPercent,
	dropNotices,
	etaMinutes,
	REFUSAL_LABELS,
	refusalRetries,
	SAVE_ERROR_LABELS,
	saveBlock,
	targetNote,
	type DropNotice,
	type EditFeature,
	type PlanState,
	type SaveErrorCode
} from "@/features/preview/videoEdit/lib/availability"
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
				"h-7 min-w-0 flex-1 rounded-full px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-40 motion-reduce:transition-none pointer-coarse:h-11",
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
	plan: PlanState
	// The ways to save, from the newest plan that worked out: kept in place (disabled) while the next one is worked out,
	// so they never vanish and come back under the pointer or the focus.
	targets: readonly VideoSaveTarget[]
	recipe: VideoEditRecipe
	info: VideoSourceInfo
	unavailable: ReadonlySet<EditFeature>
	dirty: boolean
	online: boolean
	busy: boolean
	open: boolean
	// The save button focused as the popover opens (Mod+Shift+S: the copy); null for the plan's first.
	focusTarget: VideoSaveTarget | null
	triggerRef: RefObject<HTMLButtonElement | null>
	onOpenChange: (open: boolean) => void
	onRetryPlan: () => void
	onOutput: (output: VideoEditRecipe["output"]) => void
	onRemoveLocation: (remove: boolean) => void
	// Mutes the audio: the way out when only the sound blocks the save.
	onMute: () => void
	onSave: (target: VideoSaveTarget) => void
}

// The header's Save ▾: a summary of what the save will do (fast copy or re-encode, the size and time it will take, what it
// drops, HDR, what happens to the original) with the output settings, and the ways to save the plan offers, in its
// order (the first is the primary). The summary follows the edits: worked out again after each, never a stale one.
export function SavePopover(props: SavePopoverProps) {
	const { t } = useTranslation(["preview", "common"])
	const eta = useEtaLabel()
	const { recipe, info, triggerRef } = props
	const plan = props.plan.status === "ready" ? props.plan.plan : null
	const shortSide = Math.min(info.width, info.height)
	const offline = !props.online
	const block = saveBlock(plan)
	const targets = plan?.targets ?? props.targets
	const focused = props.focusTarget !== null && targets.includes(props.focusTarget) ? props.focusTarget : targets[0]
	const focusedRef = useRef<HTMLButtonElement | null>(null)
	// Whether this opening already put the focus on its save button (once the plan was ready to save from).
	const focusDone = useRef(false)
	const ready = plan !== null

	useEffect(() => {
		if (!props.open) {
			focusDone.current = false

			return
		}

		if (ready && !focusDone.current && focusedRef.current !== null) {
			focusDone.current = true
			focusedRef.current.focus()
		}
	}, [props.open, ready])

	return (
		<Popover
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<PopoverTrigger
				render={
					<Button
						ref={triggerRef}
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
				{props.plan.status === "planning" ? (
					<div
						role="status"
						className="flex items-center gap-2 text-sm text-muted-foreground"
					>
						<Spinner className="size-4" />
						{t("previewVideoSavePlanning")}
					</div>
				) : null}
				{props.plan.status === "failed" ? (
					<div
						role="alert"
						className="flex items-center justify-between gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs"
					>
						<span className="flex items-start gap-2">
							<AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-destructive" />
							{t("previewVideoSavePlanFailed")}
						</span>
						<Button
							size="sm"
							variant="outline"
							autoFocus
							onClick={props.onRetryPlan}
						>
							{t("previewVideoSaveRetry")}
						</Button>
					</div>
				) : null}
				{plan !== null ? (
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
						{block !== null ? (
							<div
								role="alert"
								className="flex flex-col items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs"
							>
								<span className="flex items-start gap-2">
									<AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-destructive" />
									{t(block === "audio" ? "previewVideoSaveBlockedAudio" : "previewVideoSaveBlockedVideo")}
								</span>
								{block === "audio" ? (
									<Button
										size="sm"
										variant="outline"
										disabled={props.busy}
										onClick={props.onMute}
									>
										<VolumeXIcon data-icon="inline-start" />
										{t("previewVideoSaveWithoutAudio")}
									</Button>
								) : null}
							</div>
						) : null}
						<ul className="flex flex-col gap-1.5">
							{dropNotices(plan.dropped, plan.hdr).map(notice => (
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
				) : null}
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
					{targets.map((target, index) => (
						<Button
							key={target}
							ref={target === focused ? focusedRef : undefined}
							size="sm"
							variant={index === 0 ? "default" : "outline"}
							autoFocus={target === focused}
							disabled={plan === null || block !== null || offline || props.busy || !props.dirty}
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

export type ExportState =
	| { status: "running"; fraction: number; etaSeconds: number | null }
	| { status: "failed"; code: SaveErrorCode }
	| { status: "refused"; reason: VideoSaveRefusal }

// The export's progress under the header while it runs in the editor, or why it failed or was refused, with Retry where
// trying again can help (the edits stay; offline it waits). Focus follows it: to Continue in background as it starts,
// to Retry (or Dismiss) when it stops (the editor puts it back on its Save once the bar goes).
export function ExportBar(props: {
	state: ExportState
	online: boolean
	onBackground: () => void
	onCancel: () => void
	onRetry: () => void
	onDismiss: () => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const eta = useEtaLabel()
	const state = props.state
	const focusRef = useRef<HTMLButtonElement | null>(null)
	const retries = state.status === "failed" || (state.status === "refused" && refusalRetries(state.reason))

	useEffect(() => {
		focusRef.current?.focus()
	}, [state.status])

	if (state.status !== "running") {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm"
			>
				<AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					{state.status === "failed" ? (
						<>
							{t("previewVideoSaveFailed")}
							{state.code !== "unknown" ? (
								<span className="ml-1 text-muted-foreground">{t(SAVE_ERROR_LABELS[state.code])}</span>
							) : null}
						</>
					) : (
						t(REFUSAL_LABELS[state.reason])
					)}
				</span>
				<Button
					ref={retries ? undefined : focusRef}
					size="sm"
					variant="ghost"
					onClick={props.onDismiss}
				>
					{t("previewVideoSaveDismiss")}
				</Button>
				{retries ? (
					<Button
						ref={focusRef}
						size="sm"
						disabled={!props.online}
						title={props.online ? undefined : t("common:offlineActionDisabled")}
						onClick={props.onRetry}
					>
						{t("previewVideoSaveRetry")}
					</Button>
				) : null}
			</div>
		)
	}

	const percent = Math.round(Math.min(1, Math.max(0, state.fraction)) * 100)

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
			<div className="flex min-w-48 flex-1 flex-col gap-1.5">
				<span
					aria-hidden="true"
					className="text-sm tabular-nums"
				>
					{t("previewVideoSaveExporting", { percent })}
					{state.etaSeconds !== null ? <span className="text-muted-foreground"> · {eta(state.etaSeconds)}</span> : null}
				</span>
				{/* Read out in steps, not every percent the bar moves. */}
				<span
					role="status"
					className="sr-only"
				>
					{t("previewVideoSaveExporting", { percent: announcedPercent(percent) })}
				</span>
				<Progress
					value={percent}
					aria-label={t("previewVideoSaveProgressLabel")}
				/>
			</div>
			<Button
				ref={focusRef}
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
