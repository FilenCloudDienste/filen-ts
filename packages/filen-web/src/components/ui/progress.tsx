import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { cn } from "@filen/shared"

function Progress({ className, children, value, ...props }: ProgressPrimitive.Root.Props) {
	return (
		<ProgressPrimitive.Root
			value={value}
			data-slot="progress"
			className={cn("flex flex-wrap gap-3", className)}
			{...props}
		>
			{children}
			<ProgressTrack>
				<ProgressIndicator />
			</ProgressTrack>
		</ProgressPrimitive.Root>
	)
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
	return (
		<ProgressPrimitive.Track
			className={cn("relative flex h-2 w-full items-center overflow-x-hidden rounded-2xl bg-muted", className)}
			data-slot="progress-track"
			{...props}
		/>
	)
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
	return (
		<ProgressPrimitive.Indicator
			data-slot="progress-indicator"
			className={cn("h-full bg-primary transition-all", className)}
			{...props}
		/>
	)
}

export { Progress }
