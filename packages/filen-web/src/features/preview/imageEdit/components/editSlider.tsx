import { useId } from "react"
import { cn } from "@filen/shared"
import { Slider } from "@/components/ui/slider"

// Where `value` sits along the thumb's travel, in percent.
function percentOf(value: number, min: number, max: number): number {
	return max === min ? 0 : ((value - min) / (max - min)) * 100
}

// One labelled editing slider: its name, its value in a pill (marked once it moved off `neutral`), and a fill from
// `neutral` to the thumb, so a slider centred on 0 fills outwards from the middle. A double click puts it back to
// `neutral`. Arrow keys nudge by a step and Shift+Arrow by ten (the slider's own keys); the editor coalesces a drag
// or a run of nudges into one undo step.
export function EditSlider(props: {
	label: string
	value: number
	min: number
	max: number
	step: number
	neutral: number
	// The value as read out and shown; the number itself (signed when the slider is centred) when absent.
	format?: ((value: number) => string) | undefined
	// A scale of ticks under the track every `step`, taller every `major`, for a slider read against its centre.
	scale?: { step: number; major: number } | undefined
	onChange: (value: number) => void
	onReset: () => void
}) {
	const id = useId()
	const rounded = Math.round(props.value)
	const spoken = props.format === undefined ? String(rounded) : props.format(props.value)
	const centred = props.min < props.neutral
	const shown = props.format === undefined && centred && rounded > 0 ? `+${String(rounded)}` : spoken
	const modified = props.value !== props.neutral
	const at = percentOf(props.value, props.min, props.max)
	const origin = percentOf(props.neutral, props.min, props.max)
	const ticks: number[] = []

	if (props.scale !== undefined && props.scale.step > 0) {
		for (let tick = props.min; tick <= props.max; tick += props.scale.step) {
			ticks.push(tick)
		}
	}

	return (
		<div
			className="flex flex-col gap-1"
			onDoubleClick={() => {
				if (modified) {
					props.onReset()
				}
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<span
					id={`${id}-label`}
					className="truncate text-xs text-foreground"
				>
					{props.label}
				</span>
				<span
					className={cn(
						"shrink-0 rounded-full px-1.5 text-[11px] leading-5 tabular-nums transition-colors duration-150 motion-reduce:transition-none",
						modified ? "bg-edit-modified/15 font-medium text-edit-modified" : "text-muted-foreground"
					)}
				>
					{shown}
				</span>
			</div>
			<div className="relative">
				{/* The track and its fill, drawn here so the fill can start from `neutral`; the slider's own are hidden. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-input"
				>
					{centred ? (
						<span className="absolute top-1/2 left-1/2 h-2.5 w-px -translate-1/2 rounded-full bg-muted-foreground" />
					) : null}
					{/* The thumb's centre travels between half a thumb in from either end. */}
					<div className="absolute inset-x-2 inset-y-0">
						<div
							className="absolute inset-y-0 rounded-full bg-edit-modified"
							style={{ left: `${String(Math.min(at, origin))}%`, width: `${String(Math.abs(at - origin))}%` }}
						/>
					</div>
				</div>
				<Slider
					aria-labelledby={`${id}-label`}
					className="relative **:data-[slot=slider-range]:hidden **:data-[slot=slider-track]:bg-transparent"
					min={props.min}
					max={props.max}
					step={props.step}
					largeStep={props.step * 10}
					value={props.value}
					getAriaValueText={() => spoken}
					onValueChange={value => {
						props.onChange(typeof value === "number" ? value : (value[0] ?? props.neutral))
					}}
				/>
			</div>
			{ticks.length > 0 ? (
				<div
					aria-hidden="true"
					className="relative mx-2 h-2"
				>
					{ticks.map(tick => (
						<span
							key={tick}
							className={cn(
								"absolute top-0 w-px -translate-x-1/2 rounded-full",
								tick === props.neutral
									? "h-2 bg-foreground"
									: props.scale !== undefined && tick % props.scale.major === 0
										? "h-1.5 bg-muted-foreground"
										: "h-1 bg-muted-foreground/50"
							)}
							style={{ left: `${String(percentOf(tick, props.min, props.max))}%` }}
						/>
					))}
				</div>
			) : null}
		</div>
	)
}
