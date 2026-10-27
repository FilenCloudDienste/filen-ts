import { cn } from "@filen/shared"

// A rail entry's progress sliver along the icon's bottom edge; the entry itself must be `relative`.
export function RailProgressBar({ percent }: { percent: number }) {
	return (
		<span
			aria-hidden="true"
			className="absolute inset-x-2 bottom-1 h-[3px] overflow-hidden rounded-full bg-foreground/20"
		>
			<span
				className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
				style={{ width: `${String(percent)}%` }}
			/>
		</span>
	)
}

// The live figure a rail entry's tooltip adds after its label.
export function RailTooltipDetail({ children }: { children: string }) {
	return <span className="text-background/60"> · {children}</span>
}

// A status dot: attention in the destructive color, work in progress in the primary one. `className` places
// it; on a rail icon that is `absolute top-1 right-1` with a canvas ring cutting it out of the glyph.
export function RailStatusDot({ dot, className }: { dot: "attention" | "busy"; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-2 shrink-0 rounded-full", dot === "attention" ? "bg-destructive" : "bg-primary", className)}
		/>
	)
}
