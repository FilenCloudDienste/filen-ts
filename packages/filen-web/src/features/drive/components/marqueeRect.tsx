import { type MarqueeContentRect } from "@/features/drive/lib/marquee.logic"

// Rendered in content space so it stretches as the listing auto-scrolls; pointer-events-none so it never
// intercepts the ongoing drag.
export function MarqueeRect({ rect }: { rect: MarqueeContentRect | null }) {
	if (!rect) {
		return null
	}

	return (
		<div
			aria-hidden="true"
			data-testid="marquee-rect"
			className="pointer-events-none absolute z-20 rounded-xs border border-primary/60 bg-primary/15"
			style={{
				left: rect.left,
				top: rect.top,
				width: rect.right - rect.left,
				height: rect.bottom - rect.top
			}}
		/>
	)
}
