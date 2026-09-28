import { cn } from "@filen/shared"

// Decorative: whatever is loading is announced by its own surface, never by the placeholder.
function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="skeleton"
			aria-hidden="true"
			className={cn("block animate-pulse rounded-md bg-muted", className)}
			{...props}
		/>
	)
}

export { Skeleton }
