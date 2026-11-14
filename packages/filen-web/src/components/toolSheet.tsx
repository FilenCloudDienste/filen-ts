import type { ComponentProps } from "react"
import { cn } from "@filen/shared"

// An editor's tools panel: under the sm breakpoint a bottom sheet of fixed height (a grip, rounded top, a shadow, so
// switching what it shows never resizes the content above it); from sm up the caller's `className` places it. The
// image editor's inspector and the PDF editor's side panels.

const SHEET =
	"flex h-[44dvh] shrink-0 animate-in flex-col rounded-t-3xl bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.6)] ring-1 ring-border duration-300 ease-out fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none"

export function ToolSheet({ className, children, ...props }: ComponentProps<"aside">) {
	return (
		<aside
			{...props}
			className={cn(SHEET, className)}
		>
			<span
				aria-hidden="true"
				className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/20 sm:hidden"
			/>
			{children}
		</aside>
	)
}
