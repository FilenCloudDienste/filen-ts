import { middleEllipsis } from "@/lib/middleEllipsis"

export interface MiddleEllipsisProps {
	value: string
	start?: number
	end?: number
	className?: string
}

// Renders an opaque value (uuid / ip / user-agent) truncated from the MIDDLE instead of the end —
// see lib/middleEllipsis.ts for why. The untruncated value is still available via a `title` attribute
// (a native tooltip) for anyone who needs the exact string.
export function MiddleEllipsis({ value, start, end, className }: MiddleEllipsisProps) {
	return (
		<span
			title={value}
			className={className}
		>
			{middleEllipsis(value, { start, end })}
		</span>
	)
}
