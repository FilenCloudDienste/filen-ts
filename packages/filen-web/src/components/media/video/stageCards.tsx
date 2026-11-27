import { useEffect, useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { MediaTooltip } from "@/components/media/video/stageButton"
import { STAGE_POPUP_TONE_CLASS, useRestoreStageFocus } from "@/components/media/video/stageContext"
import { useRovingRadioGroup } from "@/components/media/video/useRovingRadioGroup"

// The stage's cards: a corner card (Skip, Up Next), a centred card that waits for the user (still watching,
// autoplay blocked, post-play), a notice pill, and a small panel (subtitle style, delay). All in the
// controls' dark tone without blur.

export function StageCornerCard({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
	return (
		<section
			aria-label={label}
			className={cn("w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-3 text-sm", STAGE_POPUP_TONE_CLASS, className)}
		>
			{children}
		</section>
	)
}

// A dialog in the middle of the stage; focus goes to its primary action. Escape is the caller's "back".
export function StageCenterCard({
	title,
	children,
	actions,
	onEscape
}: {
	title: string
	children?: ReactNode
	actions: ReactNode
	onEscape: () => void
}) {
	const ref = useRef<HTMLDivElement>(null)

	useRestoreStageFocus()

	useEffect(() => {
		ref.current?.querySelector<HTMLElement>("[data-primary]")?.focus({ preventScroll: true })
	}, [])

	return (
		<div
			ref={ref}
			role="dialog"
			aria-modal="false"
			aria-label={title}
			className={cn("flex w-[min(26rem,100%)] flex-col gap-4 rounded-3xl p-6 text-center", STAGE_POPUP_TONE_CLASS)}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault()
					event.stopPropagation()
					onEscape()
				} else if (event.key !== "Tab") {
					// The card's buttons keep Space and Enter; nothing here seeks the picture behind.
					event.stopPropagation()
				}
			}}
		>
			<h2 className="text-lg font-semibold text-balance">{title}</h2>
			{children}
			<div className="flex flex-wrap justify-center gap-2">{actions}</div>
		</div>
	)
}

// A pill for the stage's `notice`, whose container is the status region.
export function StageNotice({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("flex items-center gap-1 rounded-full py-1 pr-1 pl-3 text-sm", STAGE_POPUP_TONE_CLASS, className)}>
			{children}
		</div>
	)
}

// A small panel above the bar (subtitle style, delay, encoding). Escape or the close button closes it.
export function StagePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	const { t } = useTranslation("common")
	const ref = useRef<HTMLDivElement>(null)

	useRestoreStageFocus()

	useEffect(() => {
		ref.current?.querySelector<HTMLElement>("button, select, input")?.focus({ preventScroll: true })
	}, [])

	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={title}
			className={cn(
				"absolute right-[max(0.75rem,env(safe-area-inset-right))] bottom-28 z-10 flex max-h-[calc(100%-9rem)] w-[min(22rem,calc(100%-1.5rem))] flex-col gap-3 overflow-y-auto rounded-2xl p-4 text-sm",
				STAGE_POPUP_TONE_CLASS
			)}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault()
					event.stopPropagation()
					onClose()
				} else if (event.key !== "Tab") {
					event.stopPropagation()
				}
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">{title}</h2>
				<MediaTooltip label={t("close")}>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("close")}
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</MediaTooltip>
			</div>
			{children}
		</div>
	)
}

// One row of mutually exclusive choices in a panel. Choices are cheap to apply, so arrows select as they move.
export function ChoiceRow<T extends string | number>({
	label,
	options,
	value,
	onChange
}: {
	label: string
	options: readonly { value: T; label: string }[]
	value: T
	onChange: (value: T) => void
}) {
	const roving = useRovingRadioGroup({
		count: options.length,
		checked: options.findIndex(option => option.value === value),
		horizontal: true,
		onMove: index => {
			const option = options[index]

			if (option !== undefined) {
				onChange(option.value)
			}
		}
	})

	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="flex flex-col gap-1.5"
		>
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex flex-wrap gap-1">
				{options.map((option, index) => (
					<Button
						key={String(option.value)}
						{...roving(index)}
						role="radio"
						aria-checked={option.value === value}
						variant={option.value === value ? "secondary" : "outline"}
						size="xs"
						className="rounded-full"
						onClick={() => {
							onChange(option.value)
						}}
					>
						{option.label}
					</Button>
				))}
			</div>
		</div>
	)
}
