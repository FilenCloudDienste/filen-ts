import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { InfoIcon } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { setSmoothTransitionsPrefs, useSmoothTransitionsStore } from "@/features/audio/store/useSmoothTransitionsStore"
import {
	FADE_SECONDS_MAX,
	FADE_SECONDS_MIN,
	FADE_SECONDS_PRESETS,
	type ManualTransition
} from "@/features/audio/lib/smoothTransitions.types"
import { SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS, smoothTransitionsLocked } from "@/features/audio/lib/smoothTransitionsUi"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { SettingsBlock, SettingsRow } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@filen/shared"

const MANUAL_TRANSITION_OPTIONS = [
	{ value: "cut", labelKey: "settingsAudioManualSkipCut" },
	{ value: "fade", labelKey: "settingsAudioManualSkipFade" }
] as const satisfies readonly { value: ManualTransition; labelKey: string }[]

// The one Smooth transitions card: the switch, then the rows it governs (disabled while it is off). A cause the
// feature cannot run shows inline under the switch, only while there is one.
export function SmoothTransitionsRows() {
	const { t } = useTranslation(["settings", "audio"])
	const { enabled, fadeSeconds, manualTransition, matchLoudness, unavailable } = useSmoothTransitionsStore(
		useShallow(state => ({
			enabled: state.prefs.enabled,
			fadeSeconds: state.prefs.fadeSeconds,
			manualTransition: state.prefs.manualTransition,
			matchLoudness: state.prefs.matchLoudness,
			unavailable: state.unavailable
		}))
	)
	const reason = unavailable === null ? undefined : t(`audio:${SMOOTH_TRANSITIONS_UNAVAILABLE_KEYS[unavailable]}`)

	return (
		<>
			<PreferenceToggleRow
				title={t("audio:smoothTransitions")}
				description={t("settingsAudioSmoothTransitionsDescription")}
				checked={enabled}
				disabled={smoothTransitionsLocked({ enabled, unavailable })}
				disabledReason={reason}
				onCheckedChange={checked => {
					setSmoothTransitionsPrefs({ enabled: checked })
				}}
			/>
			{reason === undefined ? null : (
				<SettingsBlock className="flex items-start gap-2 text-sm text-muted-foreground">
					<InfoIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0"
					/>
					<p>{reason}</p>
				</SettingsBlock>
			)}
			<FadeLengthRow
				seconds={fadeSeconds}
				disabled={!enabled}
			/>
			<SettingsSelectRow
				label={t("settingsAudioManualSkip")}
				description={t("settingsAudioManualSkipDescription")}
				id="smooth-transitions-manual-skip"
				options={MANUAL_TRANSITION_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
				value={manualTransition}
				disabled={!enabled}
				onChange={value => {
					setSmoothTransitionsPrefs({ manualTransition: value })
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsAudioMatchLoudness")}
				description={t("settingsAudioMatchLoudnessDescription")}
				checked={matchLoudness}
				disabled={!enabled}
				onCheckedChange={checked => {
					setSmoothTransitionsPrefs({ matchLoudness: checked })
				}}
			/>
		</>
	)
}

function isPreset(seconds: number): boolean {
	return FADE_SECONDS_PRESETS.some(preset => preset === seconds)
}

function segmentClass(active: boolean): string {
	return cn(
		"h-8 min-w-0 flex-1 rounded-md px-2 text-sm font-medium whitespace-nowrap tabular-nums focus-ring transition-colors outline-none disabled:opacity-50 pointer-coarse:h-11",
		active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
	)
}

// A slider from wide widths up, segments of the common lengths plus Custom (a slider in a dialog) on a phone. CSS
// picks one, so a resize never re-renders the page. A dragged length shows at once and is saved when let go (or with
// each key step).
function FadeLengthRow({ seconds, disabled }: { seconds: number; disabled: boolean }) {
	const { t } = useTranslation("settings")
	const labelId = useId()
	const [customOpen, setCustomOpen] = useState(false)
	const [dragged, setDragged] = useState<number | null>(null)
	const label = t("settingsAudioFadeLength")
	const shown = dragged ?? seconds
	const custom = !isPreset(seconds)

	function commit(committed: number): void {
		setDragged(null)
		setSmoothTransitionsPrefs({ fadeSeconds: committed })
	}

	return (
		<SettingsRow
			label={label}
			description={t("settingsAudioFadeLengthValue", { count: shown })}
		>
			<span
				id={labelId}
				className="sr-only"
			>
				{label}
			</span>
			<FadeSlider
				seconds={shown}
				disabled={disabled}
				labelledBy={labelId}
				className="hidden sm:flex data-horizontal:w-48"
				onDrag={setDragged}
				onCommit={commit}
			/>
			<div
				role="group"
				aria-labelledby={labelId}
				className="flex w-full gap-0.5 rounded-lg bg-muted p-0.5 sm:hidden"
			>
				{FADE_SECONDS_PRESETS.map(preset => (
					<button
						key={preset}
						type="button"
						aria-pressed={preset === seconds}
						aria-label={t("settingsAudioFadeLengthValue", { count: preset })}
						disabled={disabled}
						className={segmentClass(preset === seconds)}
						onClick={() => {
							setSmoothTransitionsPrefs({ fadeSeconds: preset })
						}}
					>
						{t("settingsAudioFadeLengthShort", { count: preset })}
					</button>
				))}
				<button
					type="button"
					aria-pressed={custom}
					aria-haspopup="dialog"
					disabled={disabled}
					className={segmentClass(custom)}
					onClick={() => {
						setCustomOpen(true)
					}}
				>
					{t("settingsAudioFadeLengthCustom")}
				</button>
			</div>
			<Dialog
				open={customOpen}
				onOpenChange={setCustomOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle id={`${labelId}-dialog`}>{label}</DialogTitle>
						<DialogDescription className="tabular-nums">
							{t("settingsAudioFadeLengthValue", { count: shown })}
						</DialogDescription>
					</DialogHeader>
					<FadeSlider
						seconds={shown}
						disabled={false}
						labelledBy={`${labelId}-dialog`}
						className="py-2"
						onDrag={setDragged}
						onCommit={commit}
					/>
					<DialogFooter>
						<Button
							onClick={() => {
								setCustomOpen(false)
							}}
						>
							{t("settingsAudioFadeLengthDone")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsRow>
	)
}

function FadeSlider({
	seconds,
	disabled,
	labelledBy,
	className,
	onDrag,
	onCommit
}: {
	seconds: number
	disabled: boolean
	labelledBy: string
	className: string
	onDrag: (seconds: number) => void
	onCommit: (seconds: number) => void
}) {
	const { t } = useTranslation("settings")

	return (
		<Slider
			aria-labelledby={labelledBy}
			min={FADE_SECONDS_MIN}
			max={FADE_SECONDS_MAX}
			step={1}
			value={seconds}
			disabled={disabled}
			getAriaValueText={() => t("settingsAudioFadeLengthValue", { count: seconds })}
			className={className}
			onValueChange={next => {
				const value = typeof next === "number" ? next : next[0]

				if (value !== undefined) {
					onDrag(value)
				}
			}}
			onValueCommitted={next => {
				const value = typeof next === "number" ? next : next[0]

				if (value !== undefined) {
					onCommit(value)
				}
			}}
		/>
	)
}
