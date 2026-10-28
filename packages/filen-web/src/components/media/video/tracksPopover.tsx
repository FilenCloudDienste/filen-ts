import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { CaptionsIcon, CheckIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { SuspendDragRegions } from "@/components/ui/suspendDragRegions"
import { StageTooltip } from "@/components/media/video/stageButton"
import { STAGE_POPUP_TONE_CLASS, useStagePopupOpen, useVideoStageContainer } from "@/components/media/video/stageContext"

// Audio and subtitles side by side in one popover over the picture. Each column is a radio list
// (arrows within it, Tab to the other column); built from what is already in memory, so opening it reads
// nothing.

export interface TrackOption {
	id: string
	label: string
	// A second line: what Smart resolved to, a format, a reason it can't be chosen.
	detail?: string | undefined
	disabled?: boolean | undefined
	// Shown with a marker and this explanation (audio converted for this browser).
	note?: string | undefined
}

function RadioColumn({
	label,
	options,
	value,
	onSelect
}: {
	label: string
	options: readonly TrackOption[]
	value: string | null
	onSelect: (id: string) => void
}) {
	const items = useRef<(HTMLButtonElement | null)[]>([])
	const selectedIndex = Math.max(
		0,
		options.findIndex(option => option.id === value)
	)

	function move(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
		const edge = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null

		if (step === 0 && edge === null) {
			return
		}

		event.preventDefault()

		let next = edge ?? index

		if (edge === null) {
			let tries = options.length

			while (tries-- > 0) {
				next = (next + step + options.length) % options.length

				if (options[next]?.disabled !== true) {
					break
				}
			}
		}

		items.current[next]?.focus()
	}

	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="flex min-w-0 flex-col gap-0.5"
		>
			<p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
			{options.map((option, index) => {
				const checked = option.id === value

				return (
					<button
						key={option.id}
						ref={element => {
							items.current[index] = element
						}}
						type="button"
						role="radio"
						aria-checked={checked}
						aria-disabled={option.disabled === true}
						tabIndex={index === selectedIndex ? 0 : -1}
						className={cn(
							"flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-white/10 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40",
							option.disabled === true && "cursor-not-allowed opacity-50 hover:bg-transparent"
						)}
						onKeyDown={event => {
							move(event, index)
						}}
						onClick={() => {
							if (option.disabled !== true) {
								onSelect(option.id)
							}
						}}
					>
						<span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
							{checked ? <CheckIcon className="size-4" /> : null}
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="flex items-center gap-1 truncate">
								{option.label}
								{option.note === undefined ? null : (
									<StageTooltip label={option.note}>
										<span
											aria-label={option.note}
											className="text-muted-foreground"
										>
											*
										</span>
									</StageTooltip>
								)}
							</span>
							{option.detail === undefined ? null : (
								<span className="truncate text-xs text-muted-foreground">{option.detail}</span>
							)}
						</span>
					</button>
				)
			})}
		</div>
	)
}

export function TracksPopover({
	label,
	audio,
	audioValue,
	onAudio,
	subtitles,
	subtitleValue,
	onSubtitle,
	footer,
	onOpenChange,
	open,
	compact
}: {
	label: string
	audio: readonly TrackOption[]
	audioValue: string | null
	onAudio: (id: string) => void
	subtitles: readonly TrackOption[]
	subtitleValue: string | null
	onSubtitle: (id: string) => void
	// Below the columns: Style…, Delay…, the encoding picker.
	footer?: ReactNode
	onOpenChange: (open: boolean) => void
	open: boolean
	compact?: boolean
}) {
	const { t } = useTranslation("videos")
	const container = useVideoStageContainer()

	useStagePopupOpen(open)

	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={onOpenChange}
		>
			<StageTooltip
				label={label}
				shortcut="C"
			>
				<PopoverPrimitive.Trigger
					render={
						<Button
							variant="ghost"
							size={compact === true ? "icon-sm" : "icon"}
							aria-label={label}
							className="text-white hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white"
						/>
					}
				>
					<CaptionsIcon className="size-5" />
				</PopoverPrimitive.Trigger>
			</StageTooltip>
			<PopoverPrimitive.Portal container={container}>
				<SuspendDragRegions />
				<PopoverPrimitive.Positioner
					side="top"
					align="end"
					sideOffset={10}
					className="isolate z-50"
				>
					<PopoverPrimitive.Popup
						data-stage-popup=""
						aria-label={t("playerTracks")}
						className={cn(
							"flex max-h-[min(28rem,var(--available-height))] w-[min(34rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto rounded-2xl p-2 text-sm outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
							STAGE_POPUP_TONE_CLASS
						)}
						// The lists' keys stay in the popover; the player behind it would seek on the same arrows.
						onKeyDown={event => {
							if (event.key !== "Escape") {
								event.stopPropagation()
							}
						}}
					>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:divide-x sm:divide-white/10">
							<RadioColumn
								label={t("playerAudio")}
								options={audio}
								value={audioValue}
								onSelect={onAudio}
							/>
							<div className="sm:pl-2">
								<RadioColumn
									label={t("playerSubtitles")}
									options={subtitles}
									value={subtitleValue}
									onSelect={onSubtitle}
								/>
							</div>
						</div>
						{footer === undefined || footer === null ? null : (
							<div className="flex flex-wrap items-center justify-end gap-1 border-t border-white/10 pt-2">{footer}</div>
						)}
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	)
}
