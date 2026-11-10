import { useState } from "react"
import { useTranslation } from "react-i18next"
import { SettingsIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { PLAYBACK_RATES } from "@/lib/media/videoKeys.logic"
import { setPlaybackRate, useMediaPlaybackRate } from "@/lib/media/useMediaState"
import { StageTooltip } from "@/components/media/video/stageButton"
import { Kbd } from "@/lib/keymap/kbd"
import { MenuShortcut } from "@/components/ui/menuShortcut"
import { STAGE_POPUP_TONE_CLASS, useStagePopupOpen, useVideoStageContainer } from "@/components/media/video/stageContext"

// The gear: playback speed, then whatever the caller adds (subtitle style and delay; on a phone also the
// buttons the trimmed bar leaves out).

export interface SettingsMenuItem {
	id: string
	label: string
	// The actions whose keys in effect the item shows.
	shortcuts?: readonly string[]
	disabled?: boolean
	onSelect: () => void
}

export function StageSettingsMenu({
	video,
	items,
	compact
}: {
	video: HTMLVideoElement | null
	items: readonly SettingsMenuItem[]
	compact?: boolean
}) {
	const { t } = useTranslation("videos")
	const container = useVideoStageContainer()
	const rate = useMediaPlaybackRate(video)
	const [open, setOpen] = useState(false)

	useStagePopupOpen(open)

	return (
		<DropdownMenu
			open={open}
			onOpenChange={setOpen}
		>
			<StageTooltip label={t("playerSettings")}>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size={compact === true ? "icon-sm" : "icon"}
							aria-label={t("playerSettings")}
							className="text-white hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white"
						/>
					}
				>
					<SettingsIcon className="size-5" />
				</DropdownMenuTrigger>
			</StageTooltip>
			<DropdownMenuContent
				data-stage-popup=""
				side="top"
				align="end"
				sideOffset={10}
				container={container}
				className={cn(STAGE_POPUP_TONE_CLASS, "w-auto min-w-48 before:backdrop-blur-none before:backdrop-saturate-100")}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("playerSpeed")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={String(rate)}
						onValueChange={(next: string) => {
							if (video !== null) {
								setPlaybackRate(video, Number(next))
							}
						}}
					>
						{PLAYBACK_RATES.map(option => (
							<DropdownMenuRadioItem
								key={option}
								value={String(option)}
							>
								{option === 1 ? t("playerSpeedNormal") : t("playerSpeedRate", { rate: option })}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				{items.length === 0 ? null : <DropdownMenuSeparator />}
				{items.map(item => (
					<DropdownMenuItem
						key={item.id}
						disabled={item.disabled}
						onClick={item.onSelect}
					>
						{item.label}
						<MenuShortcut className="gap-1">
							{item.shortcuts?.map(action => (
								<Kbd
									key={action}
									action={action}
								/>
							))}
						</MenuShortcut>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
