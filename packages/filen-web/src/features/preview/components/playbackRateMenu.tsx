import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { MEDIA_GLASS_TONE_CLASS } from "@/components/ui/surface"
import { PLAYBACK_RATES } from "@/lib/media/videoKeys.logic"

// The preview players' speed menu: the rate on its trigger, the rates to pick from above it.
export function PlaybackRateMenu({
	rate,
	onRate,
	container,
	onOpenChange
}: {
	rate: number
	onRate: (rate: number) => void
	// Where the menu mounts (the player, so it shows in fullscreen); the page when null.
	container: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("preview")
	const rateLabel = t("previewMediaSpeedRate", { rate })

	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewMediaPlaybackSpeedLabel", { rate: rateLabel })}
						className="px-2 tabular-nums @max-xs:hidden"
					>
						{rateLabel}
					</Button>
				}
			/>
			<DropdownMenuContent
				side="top"
				align="end"
				container={container ?? undefined}
				// The menu opens over the picture, so it wears the controls' dark tone rather than the app's glass.
				className={cn(MEDIA_GLASS_TONE_CLASS, "w-auto min-w-36 before:backdrop-saturate-100")}
			>
				<DropdownMenuRadioGroup
					value={String(rate)}
					onValueChange={(next: string) => {
						onRate(Number(next))
					}}
				>
					<DropdownMenuLabel>{t("previewMediaPlaybackSpeed")}</DropdownMenuLabel>
					{PLAYBACK_RATES.map(option => (
						<DropdownMenuRadioItem
							key={option}
							value={String(option)}
						>
							{option === 1 ? t("previewMediaNormalSpeed") : t("previewMediaSpeedRate", { rate: option })}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
