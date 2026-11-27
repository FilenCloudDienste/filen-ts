import { useTranslation } from "react-i18next"
import { MinusIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MediaTooltip } from "@/components/media/video/stageButton"
import { ChoiceRow, StagePanel } from "@/components/media/video/stageCards"
import {
	SUBTITLE_BACKGROUNDS,
	SUBTITLE_COLORS,
	SUBTITLE_EDGES,
	SUBTITLE_FONTS,
	SUBTITLE_POSITIONS,
	SUBTITLE_SIZES,
	clampSubtitleDelay,
	formatSubtitleDelay
} from "@/lib/media/subtitles/subtitleStyle.logic"
import { SUBTITLE_DELAY_STEP_SECONDS } from "@/lib/media/videoKeys.logic"
import { resetSubtitleStyle, setSubtitleStyle, useSubtitleStyleStore } from "@/lib/media/subtitles/subtitleStyle"
import type { VideosKey } from "@/lib/i18n"

// The subtitle style (this device) and delay (this video) panels. The subtitles over the picture are the
// live preview; the style panel adds a sample line while it is open.

const SIZE_LABELS: readonly VideosKey[] = [
	"subtitleSizeSmallest",
	"subtitleSizeSmall",
	"subtitleSizeNormal",
	"subtitleSizeLarge",
	"subtitleSizeLarger",
	"subtitleSizeLargest"
]

const FONT_LABELS: Readonly<Record<(typeof SUBTITLE_FONTS)[number], VideosKey>> = {
	sans: "subtitleFontSans",
	serif: "subtitleFontSerif",
	mono: "subtitleFontMono"
}

const COLOR_LABELS: Readonly<Record<(typeof SUBTITLE_COLORS)[number], VideosKey>> = {
	white: "subtitleColorWhite",
	yellow: "subtitleColorYellow",
	cyan: "subtitleColorCyan",
	green: "subtitleColorGreen",
	magenta: "subtitleColorMagenta"
}

const BACKGROUND_LABELS: Readonly<Record<(typeof SUBTITLE_BACKGROUNDS)[number], VideosKey>> = {
	none: "subtitleBackgroundNone",
	translucent: "subtitleBackgroundTranslucent",
	solid: "subtitleBackgroundSolid"
}

const EDGE_LABELS: Readonly<Record<(typeof SUBTITLE_EDGES)[number], VideosKey>> = {
	none: "subtitleEdgeNone",
	shadow: "subtitleEdgeShadow",
	outline: "subtitleEdgeOutline",
	raised: "subtitleEdgeRaised",
	depressed: "subtitleEdgeDepressed"
}

const POSITION_LABELS: readonly VideosKey[] = [
	"subtitlePositionLowest",
	"subtitlePositionLow",
	"subtitlePositionMiddle",
	"subtitlePositionHigh",
	"subtitlePositionHighest"
]

export function SubtitleStylePanel({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation("videos")
	const style = useSubtitleStyleStore()

	return (
		<StagePanel
			title={t("subtitleStyleTitle")}
			onClose={onClose}
		>
			<ChoiceRow
				label={t("subtitleSize")}
				value={style.size}
				options={SUBTITLE_SIZES.map((_, index) => ({ value: index, label: t(SIZE_LABELS[index] ?? "subtitleSizeNormal") }))}
				onChange={size => {
					setSubtitleStyle({ size })
				}}
			/>
			<ChoiceRow
				label={t("subtitleFont")}
				value={style.font}
				options={SUBTITLE_FONTS.map(font => ({ value: font, label: t(FONT_LABELS[font]) }))}
				onChange={font => {
					setSubtitleStyle({ font })
				}}
			/>
			<ChoiceRow
				label={t("subtitleColor")}
				value={style.color}
				options={SUBTITLE_COLORS.map(color => ({ value: color, label: t(COLOR_LABELS[color]) }))}
				onChange={color => {
					setSubtitleStyle({ color })
				}}
			/>
			<ChoiceRow
				label={t("subtitleBackground")}
				value={style.background}
				options={SUBTITLE_BACKGROUNDS.map(background => ({ value: background, label: t(BACKGROUND_LABELS[background]) }))}
				onChange={background => {
					setSubtitleStyle({ background })
				}}
			/>
			<ChoiceRow
				label={t("subtitleEdge")}
				value={style.edge}
				options={SUBTITLE_EDGES.map(edge => ({ value: edge, label: t(EDGE_LABELS[edge]) }))}
				onChange={edge => {
					setSubtitleStyle({ edge })
				}}
			/>
			<ChoiceRow
				label={t("subtitlePosition")}
				value={style.position}
				options={SUBTITLE_POSITIONS.map((_, index) => ({
					value: index,
					label: t(POSITION_LABELS[index] ?? "subtitlePositionLow")
				}))}
				onChange={position => {
					setSubtitleStyle({ position })
				}}
			/>
			<div className="flex justify-end">
				<Button
					variant="ghost"
					size="sm"
					onClick={resetSubtitleStyle}
				>
					{t("subtitleStyleReset")}
				</Button>
			</div>
		</StagePanel>
	)
}

export function SubtitleDelayPanel({
	delay,
	onChange,
	onClose
}: {
	delay: number
	onChange: (seconds: number) => void
	onClose: () => void
}) {
	const { t } = useTranslation("videos")

	return (
		<StagePanel
			title={t("subtitleDelayTitle")}
			onClose={onClose}
		>
			<div className="flex items-center justify-between gap-2">
				<MediaTooltip
					label={t("subtitleDelayEarlier")}
					action="media.subtitleEarlier"
				>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("subtitleDelayEarlier")}
						onClick={() => {
							onChange(clampSubtitleDelay(delay - SUBTITLE_DELAY_STEP_SECONDS))
						}}
					>
						<MinusIcon />
					</Button>
				</MediaTooltip>
				<output
					aria-live="polite"
					className="text-lg font-medium tabular-nums"
				>
					{formatSubtitleDelay(delay)}
				</output>
				<MediaTooltip
					label={t("subtitleDelayLater")}
					action="media.subtitleLater"
				>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("subtitleDelayLater")}
						onClick={() => {
							onChange(clampSubtitleDelay(delay + SUBTITLE_DELAY_STEP_SECONDS))
						}}
					>
						<PlusIcon />
					</Button>
				</MediaTooltip>
			</div>
			<p className="text-xs text-muted-foreground">{t("subtitleDelayHint")}</p>
			<div className="flex justify-end">
				<Button
					variant="ghost"
					size="sm"
					disabled={delay === 0}
					onClick={() => {
						onChange(0)
					}}
				>
					{t("subtitleDelayReset")}
				</Button>
			</div>
		</StagePanel>
	)
}
