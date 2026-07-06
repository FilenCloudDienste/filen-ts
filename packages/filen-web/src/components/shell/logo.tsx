import { cn } from "@/lib/utils"

// Brand mark: a rounded flat-top hexagon (Filen's identity), drawn in `currentColor` so it inherits
// the surrounding text color and themes with light/dark on any surface. Corner rounding comes from a
// same-color round-joined stroke rather than a hand-computed arc path. The inner hexagon is punched
// out via `evenodd` (a true transparent hole, so the underlying surface shows through regardless of
// where the mark sits). Decorative only — `aria-hidden`; the accessible product name is `appName`.
function Logo({ className, ...props }: React.ComponentProps<"svg">) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			className={cn("size-6", className)}
			{...props}
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinejoin="round"
				d="M2.9 12 7.45 4.12h9.1L21.1 12l-4.55 7.88h-9.1L2.9 12Zm6.02 0L12 17.32 15.08 12 12 6.68 8.92 12Z"
			/>
		</svg>
	)
}

export { Logo }
