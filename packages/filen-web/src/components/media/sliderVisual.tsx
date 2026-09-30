import { cn } from "@filen/shared"
import type { TimeRange } from "@/lib/media/scrubber.logic"

// The drawn rail, fill and thumb of the media sliders. The input that owns the value sits before it as
// the `peer`, so its keyboard focus shows here; the wrapper is the `group/slider` its hover grows.
export function SliderVisual({
	percent,
	segments,
	duration,
	thumbShown
}: {
	percent: number
	// Buffered ranges, drawn under the fill.
	segments?: readonly TimeRange[] | undefined
	duration?: number | undefined
	thumbShown?: boolean | undefined
}) {
	return (
		<>
			<div
				aria-hidden="true"
				className="pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-foreground/15 transition-[height] duration-150 group-hover/slider:h-1.5 motion-reduce:transition-none"
			>
				{segments !== undefined && duration !== undefined && duration > 0
					? segments.map(segment => (
							<div
								key={segment.start}
								className="absolute inset-y-0 bg-foreground/20"
								style={{
									left: `${String((segment.start / duration) * 100)}%`,
									width: `${String(((Math.min(segment.end, duration) - segment.start) / duration) * 100)}%`
								}}
							/>
						))
					: null}
				<div
					className="absolute inset-y-0 left-0 bg-primary"
					style={{ width: `${String(percent)}%` }}
				/>
			</div>
			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute top-1/2 size-3 -translate-1/2 rounded-full bg-primary shadow-sm transition-opacity duration-150 group-hover/slider:opacity-100 peer-focus-visible:opacity-100 peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 motion-reduce:transition-none",
					thumbShown === true ? "opacity-100" : "opacity-0"
				)}
				style={{ left: `${String(percent)}%` }}
			/>
		</>
	)
}
