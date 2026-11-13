import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	AudioLinesIcon,
	CropIcon,
	FlipHorizontal2Icon,
	FlipVertical2Icon,
	GaugeIcon,
	PlusIcon,
	RotateCcwIcon,
	RotateCcwSquareIcon,
	RotateCwSquareIcon,
	ScissorsIcon,
	SunMediumIcon,
	Trash2Icon,
	TypeIcon,
	Undo2Icon
} from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { EditSlider } from "@/features/preview/imageEdit/components/editSlider"
import { Chip, FilterThumbnail, FilterTile, Section, TurnButton } from "@/features/preview/components/editPanelParts"
import { editTabClass, editTabIds } from "@/features/preview/components/editPanelTabs"
import { FILTER_PRESETS } from "@/features/preview/imageEdit/lib/filters"
import type { AspectPreset } from "@/features/preview/imageEdit/types"
import type { TextOverlay, TimeRange, VideoAdjustments, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import {
	clampGain,
	clampSpeed,
	clampTextSize,
	clampTextTimes,
	keepsTrack,
	MAX_GAIN_DB,
	MAX_SPEED,
	MAX_TEXT_SIZE,
	MIN_GAIN_DB,
	MIN_SPEED,
	MIN_TEXT_SIZE,
	outputDuration,
	removedRanges,
	sourceToOutput,
	SPEED_PRESETS,
	toggleTrack,
	VIDEO_ASPECTS
} from "@/features/preview/videoEdit/lib/recipe"
import { formatTimecode } from "@/features/preview/videoEdit/lib/timeline.logic"
import type { EditFeature } from "@/features/preview/videoEdit/lib/availability"
import { TimecodeField } from "@/features/preview/videoEdit/components/timecodeField"
import type { NamespaceKey } from "@/lib/i18n"

type PreviewKey = NamespaceKey<"preview">

export type VideoEditTab = "trim" | "crop" | "adjust" | "audio" | "speed" | "text"

const VIDEO_EDIT_TABS: readonly { id: VideoEditTab; labelKey: PreviewKey; icon: ReactNode }[] = [
	{ id: "trim", labelKey: "previewVideoEditTabTrim", icon: <ScissorsIcon /> },
	{ id: "crop", labelKey: "previewVideoEditTabCrop", icon: <CropIcon /> },
	{ id: "adjust", labelKey: "previewVideoEditTabAdjust", icon: <SunMediumIcon /> },
	{ id: "audio", labelKey: "previewVideoEditTabAudio", icon: <AudioLinesIcon /> },
	{ id: "speed", labelKey: "previewVideoEditTabSpeed", icon: <GaugeIcon /> },
	{ id: "text", labelKey: "previewVideoEditTabText", icon: <TypeIcon /> }
]

const ADJUST_SECTIONS: readonly { labelKey: PreviewKey; sliders: readonly { key: keyof VideoAdjustments; labelKey: PreviewKey }[] }[] = [
	{
		labelKey: "previewImageEditSectionLight",
		sliders: [
			{ key: "exposure", labelKey: "previewImageEditExposure" },
			{ key: "brightness", labelKey: "previewImageEditBrightness" },
			{ key: "contrast", labelKey: "previewImageEditContrast" },
			{ key: "highlights", labelKey: "previewImageEditHighlights" },
			{ key: "shadows", labelKey: "previewImageEditShadows" }
		]
	},
	{
		labelKey: "previewImageEditSectionColour",
		sliders: [
			{ key: "warmth", labelKey: "previewImageEditWarmth" },
			{ key: "tint", labelKey: "previewImageEditTint" },
			{ key: "saturation", labelKey: "previewImageEditSaturation" },
			{ key: "vibrance", labelKey: "previewImageEditVibrance" }
		]
	}
]

const ASPECT_LABELS: Readonly<Partial<Record<AspectPreset, PreviewKey>>> = {
	free: "previewImageEditAspectFree",
	original: "previewImageEditAspectOriginal",
	square: "previewImageEditAspectSquare"
}

const TEXT_COLORS: readonly { color: string; labelKey: PreviewKey }[] = [
	{ color: "#ffffff", labelKey: "previewVideoEditColorWhite" },
	{ color: "#000000", labelKey: "previewVideoEditColorBlack" },
	{ color: "#facc15", labelKey: "previewVideoEditColorYellow" },
	{ color: "#ef4444", labelKey: "previewVideoEditColorRed" },
	{ color: "#3b82f6", labelKey: "previewVideoEditColorBlue" }
]

// Why a control is off: this browser cannot save it.
function Unavailable(props: { show: boolean; text: string }) {
	return props.show ? <p className="rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">{props.text}</p> : null
}

function SwitchRow(props: { label: string; checked: boolean; disabled?: boolean | undefined; onChange: (checked: boolean) => void }) {
	return (
		<label className="flex items-center justify-between gap-3 text-sm">
			<span>{props.label}</span>
			<Switch
				checked={props.checked}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
			/>
		</label>
	)
}

export interface VideoEditPanelProps {
	idBase: string
	tab: VideoEditTab
	recipe: VideoEditRecipe
	info: VideoSourceInfo
	unavailable: ReadonlySet<EditFeature>
	// The source is HDR: colour work on it saves the video as SDR (the Save popover says so too).
	hdrNote: boolean
	selection: TimeRange | null
	aspect: AspectPreset
	selectedText: string | null
	// The unfiltered frame, then one per FILTER_PRESETS entry, once drawn.
	thumbnails: readonly ImageBitmap[] | null
	onTab: (tab: VideoEditTab) => void
	// Every recipe change: `change` applied to the recipe as it stands, `coalesceKey` merging a run into one undo step.
	onChange: (change: (recipe: VideoEditRecipe) => VideoEditRecipe, coalesceKey?: string) => void
	onTrim: (edge: "start" | "end", time: number) => void
	onSelection: (range: TimeRange | null) => void
	onRemoveSelection: () => void
	onRestore: (range: TimeRange) => void
	onAspect: (aspect: AspectPreset) => void
	onTurn: (direction: "left" | "right") => void
	onFlip: (axis: "horizontal" | "vertical") => void
	onResetCrop: () => void
	onAddText: () => void
	onSelectText: (id: string | null) => void
}

// The tools beside the video (beneath it under the sm breakpoint): Trim, Crop, Adjust, Audio, Speed and Text tabs.
export function VideoEditPanel(props: VideoEditPanelProps) {
	const { t } = useTranslation("preview")
	const { recipe, info, unavailable } = props
	const duration = info.duration
	const output = outputDuration(recipe.keep, recipe.speed)
	const first = recipe.keep[0]
	const last = recipe.keep[recipe.keep.length - 1]
	// Gaps between kept parts (the trims at either end have their own fields).
	const cutOuts = removedRanges(recipe.keep, duration).filter(range => range.start > 0 && range.end < duration)
	const colourOff = unavailable.has("adjust")
	const selectedText = recipe.text.find(text => text.id === props.selectedText) ?? null
	const unavailableText = t("previewVideoEditFeatureUnavailable")

	const handleTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const index = VIDEO_EDIT_TABS.findIndex(tab => tab.id === props.tab)
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0

		if (step === 0) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		const next = VIDEO_EDIT_TABS[(index + step + VIDEO_EDIT_TABS.length) % VIDEO_EDIT_TABS.length]

		if (next !== undefined) {
			props.onTab(next.id)
			document.getElementById(editTabIds(props.idBase, next.id).tab)?.focus()
		}
	}

	const changeText = (id: string, change: (text: TextOverlay) => TextOverlay, coalesceKey?: string): void => {
		props.onChange(current => ({ ...current, text: current.text.map(text => (text.id === id ? change(text) : text)) }), coalesceKey)
	}

	const ids = editTabIds(props.idBase, props.tab)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				role="tablist"
				aria-label={t("previewVideoEditTools")}
				className="mx-4 mt-3 grid shrink-0 grid-cols-6 gap-0.5 rounded-full bg-canvas p-1 sm:rounded-2xl"
				onKeyDown={handleTabKey}
			>
				{VIDEO_EDIT_TABS.map(tab => {
					const selected = tab.id === props.tab

					return (
						<button
							key={tab.id}
							type="button"
							id={editTabIds(props.idBase, tab.id).tab}
							role="tab"
							aria-selected={selected}
							aria-controls={editTabIds(props.idBase, tab.id).panel}
							tabIndex={selected ? 0 : -1}
							className={editTabClass(selected, true)}
							onClick={() => {
								props.onTab(tab.id)
							}}
						>
							{tab.icon}
							<span className="truncate max-sm:sr-only">{t(tab.labelKey)}</span>
						</button>
					)
				})}
			</div>
			<div
				id={ids.panel}
				role="tabpanel"
				aria-labelledby={ids.tab}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-4"
			>
				{props.tab === "trim" ? (
					<div className="flex flex-col gap-6">
						<div className="grid grid-cols-2 gap-2">
							<TimecodeField
								label={t("previewVideoEditStart")}
								value={first?.start ?? 0}
								onCommit={seconds => {
									props.onTrim("start", seconds)
								}}
							/>
							<TimecodeField
								label={t("previewVideoEditEnd")}
								value={last?.end ?? duration}
								onCommit={seconds => {
									props.onTrim("end", seconds)
								}}
							/>
						</div>
						<div className="flex items-center justify-between text-xs">
							<span className="text-muted-foreground">{t("previewVideoEditOutputLength")}</span>
							<span className="font-medium tabular-nums">{formatTimecode(output)}</span>
						</div>
						<Section label={t("previewVideoEditSelection")}>
							{props.selection === null ? (
								<p className="text-xs text-muted-foreground">{t("previewVideoEditSelectionHint")}</p>
							) : (
								<>
									<div className="grid grid-cols-2 gap-2">
										<TimecodeField
											label={t("previewVideoEditSelectionIn")}
											value={props.selection.start}
											onCommit={seconds => {
												const selection = props.selection

												if (selection !== null) {
													props.onSelection({ start: Math.min(seconds, selection.end), end: selection.end })
												}
											}}
										/>
										<TimecodeField
											label={t("previewVideoEditSelectionOut")}
											value={props.selection.end}
											onCommit={seconds => {
												const selection = props.selection

												if (selection !== null) {
													props.onSelection({ start: selection.start, end: Math.max(seconds, selection.start) })
												}
											}}
										/>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="destructive"
											onClick={props.onRemoveSelection}
										>
											<ScissorsIcon data-icon="inline-start" />
											{t("previewVideoEditRemoveSection")}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => {
												props.onSelection(null)
											}}
										>
											{t("previewVideoEditClearSelection")}
										</Button>
									</div>
								</>
							)}
						</Section>
						<Section label={t("previewVideoEditRemovedSections")}>
							{cutOuts.length === 0 ? (
								<p className="text-xs text-muted-foreground">{t("previewVideoEditNoRemovedSections")}</p>
							) : (
								<ul className="flex flex-col gap-1">
									{cutOuts.map(range => {
										const start = formatTimecode(range.start)
										const end = formatTimecode(range.end)

										return (
											<li
												key={`${String(range.start)}-${String(range.end)}`}
												className="flex items-center justify-between gap-2 rounded-xl bg-muted px-3 py-1.5 text-xs tabular-nums"
											>
												<span>
													{start} – {end}
												</span>
												<Button
													size="xs"
													variant="ghost"
													aria-label={t("previewVideoEditRestoreSectionLabel", { start, end })}
													onClick={() => {
														props.onRestore(range)
													}}
												>
													<Undo2Icon data-icon="inline-start" />
													{t("previewVideoEditRestoreSection")}
												</Button>
											</li>
										)
									})}
								</ul>
							)}
						</Section>
						<div className="flex flex-col gap-1.5">
							<SwitchRow
								label={t("previewVideoEditPrecise")}
								checked={recipe.precise}
								disabled={unavailable.has("precise")}
								onChange={checked => {
									props.onChange(current => ({ ...current, precise: checked }))
								}}
							/>
							<p className="text-xs text-muted-foreground">
								{unavailable.has("precise") ? unavailableText : t("previewVideoEditPreciseHint")}
							</p>
						</div>
					</div>
				) : null}
				{props.tab === "crop" ? (
					<div className="flex flex-col gap-6">
						<Unavailable
							show={unavailable.has("crop")}
							text={unavailableText}
						/>
						<Section label={t("previewVideoEditAspect")}>
							<div className="flex flex-wrap gap-1.5">
								{VIDEO_ASPECTS.map(aspect => {
									const labelKey = ASPECT_LABELS[aspect]

									return (
										<Chip
											key={aspect}
											selected={props.aspect === aspect}
											disabled={unavailable.has("crop")}
											onClick={() => {
												props.onAspect(aspect)
											}}
										>
											{labelKey === undefined ? aspect : t(labelKey)}
										</Chip>
									)
								})}
							</div>
							{recipe.crop !== null ? (
								<span className="text-xs text-muted-foreground tabular-nums">
									{t("previewVideoEditCropSize", { width: recipe.crop.width, height: recipe.crop.height })}
								</span>
							) : null}
						</Section>
						<div className="grid grid-cols-4 gap-2">
							<TurnButton
								label={t("previewVideoEditRotateLeft")}
								icon={<RotateCcwSquareIcon />}
								disabled={unavailable.has("rotate")}
								onClick={() => {
									props.onTurn("left")
								}}
							/>
							<TurnButton
								label={t("previewVideoEditRotateRight")}
								icon={<RotateCwSquareIcon />}
								disabled={unavailable.has("rotate")}
								onClick={() => {
									props.onTurn("right")
								}}
							/>
							<TurnButton
								label={t("previewVideoEditFlipHorizontal")}
								icon={<FlipHorizontal2Icon />}
								disabled={unavailable.has("flip")}
								onClick={() => {
									props.onFlip("horizontal")
								}}
							/>
							<TurnButton
								label={t("previewVideoEditFlipVertical")}
								icon={<FlipVertical2Icon />}
								disabled={unavailable.has("flip")}
								onClick={() => {
									props.onFlip("vertical")
								}}
							/>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="self-start text-muted-foreground"
							onClick={props.onResetCrop}
						>
							<RotateCcwIcon data-icon="inline-start" />
							{t("previewVideoEditResetCrop")}
						</Button>
					</div>
				) : null}
				{props.tab === "adjust" ? (
					<div className="flex flex-col gap-6">
						<Unavailable
							show={colourOff}
							text={unavailableText}
						/>
						<Unavailable
							show={!colourOff && props.hdrNote}
							text={t("previewVideoEditAdjustHdr")}
						/>
						{ADJUST_SECTIONS.map(section => (
							<Section
								key={section.labelKey}
								label={t(section.labelKey)}
							>
								<div className="flex flex-col gap-3.5">
									{section.sliders.map(({ key, labelKey }) => (
										<EditSlider
											key={key}
											label={t(labelKey)}
											value={recipe.adjust[key]}
											min={-100}
											max={100}
											step={1}
											neutral={0}
											disabled={colourOff}
											onChange={value => {
												props.onChange(
													current => ({ ...current, adjust: { ...current.adjust, [key]: value } }),
													`adjust-${key}`
												)
											}}
											onReset={() => {
												props.onChange(current => ({ ...current, adjust: { ...current.adjust, [key]: 0 } }))
											}}
										/>
									))}
								</div>
							</Section>
						))}
						<Section label={t("previewVideoEditFilters")}>
							<div className="grid grid-cols-3 gap-x-2.5 gap-y-3">
								<FilterTile
									label={t("previewImageEditFilterNone")}
									selected={recipe.filter === null}
									disabled={colourOff}
									onClick={() => {
										props.onChange(current => ({ ...current, filter: null }))
									}}
								>
									<FilterThumbnail bitmap={props.thumbnails?.[0]} />
								</FilterTile>
								{FILTER_PRESETS.map((preset, index) => (
									<FilterTile
										key={preset.id}
										label={t(preset.labelKey)}
										selected={recipe.filter === preset.id}
										disabled={colourOff}
										onClick={() => {
											props.onChange(current => ({ ...current, filter: preset.id }))
										}}
									>
										<FilterThumbnail bitmap={props.thumbnails?.[index + 1]} />
									</FilterTile>
								))}
							</div>
						</Section>
						<p className="text-xs text-muted-foreground">{t("previewVideoEditPausedPreviewHint")}</p>
					</div>
				) : null}
				{props.tab === "audio" ? (
					<div className="flex flex-col gap-6">
						{info.audio.length === 0 ? (
							<p className="text-xs text-muted-foreground">{t("previewVideoEditNoAudio")}</p>
						) : (
							<>
								<SwitchRow
									label={t("previewVideoEditMute")}
									checked={recipe.audio.mute}
									onChange={checked => {
										props.onChange(current => ({ ...current, audio: { ...current.audio, mute: checked } }))
									}}
								/>
								<div className="flex flex-col gap-1.5">
									<EditSlider
										label={t("previewVideoEditGain")}
										value={recipe.audio.gainDb}
										min={MIN_GAIN_DB}
										max={MAX_GAIN_DB}
										step={0.5}
										neutral={0}
										disabled={recipe.audio.mute || unavailable.has("gain")}
										format={value =>
											t("previewVideoEditGainValue", {
												gain: `${value > 0 ? "+" : ""}${clampGain(value).toFixed(1)}`
											})
										}
										onChange={value => {
											props.onChange(
												current => ({ ...current, audio: { ...current.audio, gainDb: clampGain(value) } }),
												"gain"
											)
										}}
										onReset={() => {
											props.onChange(current => ({ ...current, audio: { ...current.audio, gainDb: 0 } }))
										}}
									/>
									<p className="text-xs text-muted-foreground">
										{unavailable.has("gain") ? unavailableText : t("previewVideoEditGainHint")}
									</p>
								</div>
								{info.audio.length > 1 ? (
									<Section label={t("previewVideoEditTracks")}>
										<Unavailable
											show={unavailable.has("audioTracks")}
											text={unavailableText}
										/>
										{info.audio.map(track => (
											<SwitchRow
												key={track.number}
												label={
													track.language === null
														? t("previewVideoEditTrack", { number: track.number })
														: t("previewVideoEditTrackLanguage", {
																number: track.number,
																language: track.language
															})
												}
												checked={keepsTrack(recipe.audio.keepTracks, track.number, info.audio[0]?.number)}
												disabled={recipe.audio.mute || unavailable.has("audioTracks")}
												onChange={() => {
													props.onChange(current => ({
														...current,
														audio: {
															...current.audio,
															keepTracks: toggleTrack(
																current.audio.keepTracks,
																track.number,
																info.audio.map(entry => entry.number)
															)
														}
													}))
												}}
											/>
										))}
									</Section>
								) : null}
							</>
						)}
					</div>
				) : null}
				{props.tab === "speed" ? (
					<div className="flex flex-col gap-6">
						<Unavailable
							show={unavailable.has("speed")}
							text={unavailableText}
						/>
						<Section label={t("previewVideoEditSpeed")}>
							<div className="flex flex-wrap gap-1.5">
								{SPEED_PRESETS.map(speed => (
									<Chip
										key={speed}
										selected={recipe.speed === speed}
										disabled={unavailable.has("speed")}
										onClick={() => {
											props.onChange(current => ({ ...current, speed }))
										}}
									>
										{t("previewVideoEditSpeedValue", { speed })}
									</Chip>
								))}
							</div>
						</Section>
						<EditSlider
							label={t("previewVideoEditSpeed")}
							value={recipe.speed}
							min={MIN_SPEED}
							max={MAX_SPEED}
							step={0.05}
							neutral={1}
							disabled={unavailable.has("speed")}
							format={value => t("previewVideoEditSpeedValue", { speed: clampSpeed(value) })}
							onChange={value => {
								props.onChange(current => ({ ...current, speed: clampSpeed(value) }), "speed")
							}}
							onReset={() => {
								props.onChange(current => ({ ...current, speed: 1 }))
							}}
						/>
						<p className="text-xs text-muted-foreground">{t("previewVideoEditSpeedHint")}</p>
					</div>
				) : null}
				{props.tab === "text" ? (
					<div className="flex flex-col gap-6">
						<Unavailable
							show={unavailable.has("text")}
							text={unavailableText}
						/>
						<Button
							size="sm"
							variant="secondary"
							className="self-start"
							disabled={unavailable.has("text")}
							onClick={props.onAddText}
						>
							<PlusIcon data-icon="inline-start" />
							{t("previewVideoEditAddText")}
						</Button>
						{recipe.text.length === 0 ? (
							<p className="text-xs text-muted-foreground">{t("previewVideoEditNoText")}</p>
						) : (
							<div className="flex flex-wrap gap-1.5">
								{recipe.text.map(text => (
									<Chip
										key={text.id}
										selected={props.selectedText === text.id}
										onClick={() => {
											props.onSelectText(text.id)
										}}
									>
										<span className="block max-w-32 truncate">{text.text}</span>
									</Chip>
								))}
							</div>
						)}
						{selectedText !== null ? (
							<div className="flex flex-col gap-4">
								<label className="flex flex-col gap-1">
									<span className="text-xs text-muted-foreground">{t("previewVideoEditTextField")}</span>
									<Input
										value={selectedText.text}
										className="h-8 leading-5"
										onChange={event => {
											const value = event.target.value

											changeText(selectedText.id, text => ({ ...text, text: value }), `text-${selectedText.id}`)
										}}
									/>
								</label>
								<EditSlider
									label={t("previewVideoEditTextSize")}
									value={Math.round(selectedText.size * 100)}
									min={Math.round(MIN_TEXT_SIZE * 100)}
									max={Math.round(MAX_TEXT_SIZE * 100)}
									step={1}
									neutral={8}
									onChange={value => {
										changeText(
											selectedText.id,
											text => ({ ...text, size: clampTextSize(value / 100) }),
											`text-size-${selectedText.id}`
										)
									}}
									onReset={() => {
										changeText(selectedText.id, text => ({ ...text, size: 0.08 }))
									}}
								/>
								<Section label={t("previewVideoEditTextColor")}>
									<div className="flex flex-wrap gap-1">
										{TEXT_COLORS.map(({ color, labelKey }) => {
											const selected = selectedText.color === color

											return (
												<button
													key={color}
													type="button"
													aria-label={t(labelKey)}
													aria-pressed={selected}
													className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
													onClick={() => {
														changeText(selectedText.id, text => ({ ...text, color }))
													}}
												>
													<span
														className={cn(
															"size-6 rounded-full",
															selected
																? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
																: "ring-1 ring-foreground/25"
														)}
														style={{ backgroundColor: color }}
													/>
												</button>
											)
										})}
									</div>
								</Section>
								<SwitchRow
									label={t("previewVideoEditTextBackground")}
									checked={selectedText.background}
									onChange={checked => {
										changeText(selectedText.id, text => ({ ...text, background: checked }))
									}}
								/>
								<div className="grid grid-cols-2 gap-2">
									<TimecodeField
										label={t("previewVideoEditTextFrom")}
										value={selectedText.startSec}
										onCommit={seconds => {
											changeText(selectedText.id, text => clampTextTimes({ ...text, startSec: seconds }, output))
										}}
									/>
									<TimecodeField
										label={t("previewVideoEditTextTo")}
										value={selectedText.endSec}
										onCommit={seconds => {
											changeText(selectedText.id, text => clampTextTimes({ ...text, endSec: seconds }, output))
										}}
									/>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="ghost"
										disabled={props.selection === null}
										onClick={() => {
											const selection = props.selection

											if (selection !== null) {
												changeText(selectedText.id, text =>
													clampTextTimes(
														{
															...text,
															startSec: sourceToOutput(recipe.keep, recipe.speed, selection.start),
															endSec: sourceToOutput(recipe.keep, recipe.speed, selection.end)
														},
														output
													)
												)
											}
										}}
									>
										{t("previewVideoEditTextUseSelection")}
									</Button>
									<Button
										size="sm"
										variant="destructive"
										onClick={() => {
											props.onChange(current => ({
												...current,
												text: current.text.filter(text => text.id !== selectedText.id)
											}))
											props.onSelectText(null)
										}}
									>
										<Trash2Icon data-icon="inline-start" />
										{t("previewVideoEditTextDelete")}
									</Button>
								</div>
							</div>
						) : null}
						<p className="text-xs text-muted-foreground">{t("previewVideoEditTextHint")}</p>
					</div>
				) : null}
			</div>
		</div>
	)
}
