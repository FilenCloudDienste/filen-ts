import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@filen/shared"

interface SliderProps extends SliderPrimitive.Root.Props {
	// Read by assistive tech per thumb, e.g. "Level 5" instead of the bare number.
	getAriaValueText?: ((formattedValue: string, value: number, index: number) => string) | undefined
}

function Slider({ className, defaultValue, value, min: minProp, max: maxProp, getAriaValueText, ...props }: SliderProps) {
	// Not destructuring defaults, which the React Compiler cannot lower.
	const min = minProp ?? 0
	const max = maxProp ?? 100
	const values = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]
	const thumbCount = typeof value === "number" || typeof defaultValue === "number" ? 1 : values.length

	return (
		<SliderPrimitive.Root
			className={cn("data-horizontal:w-full data-vertical:h-full", className)}
			data-slot="slider"
			defaultValue={defaultValue}
			value={value}
			min={min}
			max={max}
			thumbAlignment="edge"
			{...props}
		>
			<SliderPrimitive.Control className="relative flex w-full touch-none items-center py-1.5 select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
				<SliderPrimitive.Track
					data-slot="slider-track"
					className="relative grow overflow-hidden rounded-2xl bg-input/90 select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
				>
					<SliderPrimitive.Indicator
						data-slot="slider-range"
						className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
					/>
				</SliderPrimitive.Track>
				{Array.from({ length: thumbCount }, (_, index) => (
					<SliderPrimitive.Thumb
						data-slot="slider-thumb"
						key={index}
						getAriaValueText={getAriaValueText}
						className="block size-4 shrink-0 rounded-2xl bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow] duration-200 select-none not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 has-focus-visible:ring-4 has-focus-visible:ring-ring/30 data-disabled:pointer-events-none"
					/>
				))}
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	)
}

export { Slider }
