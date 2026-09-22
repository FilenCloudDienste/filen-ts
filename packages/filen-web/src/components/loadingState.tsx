import { cn } from "@filen/shared"
import { Spinner } from "@/components/ui/spinner"

const SIZE_CLASS: Record<"sm" | "md" | "lg", string> = {
	sm: "size-4",
	md: "size-6",
	lg: "size-8"
}

// Centers in a flex column, a grid cell or a sized block. The Spinner already carries role="status"
// and the label, so the wrapper stays role-less (a second live region announces twice). `className`
// reserves a minimum height where the parent sizes to its content, or overrides the color the spinner
// inherits.
export function LoadingState({ size, className }: { size: "sm" | "md" | "lg"; className?: string }) {
	return (
		<div className={cn("flex h-full min-h-0 w-full flex-1 items-center justify-center self-stretch text-muted-foreground", className)}>
			<Spinner className={SIZE_CLASS[size]} />
		</div>
	)
}
