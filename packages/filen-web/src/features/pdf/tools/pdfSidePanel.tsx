import type { ComponentProps } from "react"
import { cn } from "@filen/shared"
import { ToolSheet } from "@/components/toolSheet"

// A PDF tool's side panel: beside the pages from the sm breakpoint up, a bottom sheet under the pages on a phone (the
// image editor's sheet). Name it with aria-label.
export function PdfSidePanel({ className, ...props }: ComponentProps<"aside">) {
	return (
		<ToolSheet
			{...props}
			className={cn(
				"sm:h-full sm:w-80 sm:animate-none sm:rounded-none sm:border-l sm:border-border sm:shadow-none sm:ring-0",
				className
			)}
		/>
	)
}
