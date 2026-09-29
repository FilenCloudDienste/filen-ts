import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@filen/shared"
import { INVALID_RING_CLASS } from "@/components/ui/surface"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer group/switch relative inline-flex h-5 w-8 shrink-0 items-center rounded-2xl border-2 focus-ring transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring data-checked:border-primary data-checked:bg-primary data-unchecked:border-transparent data-unchecked:bg-input/90 data-disabled:cursor-not-allowed data-disabled:opacity-50",
				INVALID_RING_CLASS,
				className
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-4 rounded-2xl bg-background shadow-sm ring-0 transition-transform not-dark:bg-clip-padding data-checked:translate-x-[calc(100%-4px)] dark:data-checked:bg-primary-foreground data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground"
			/>
		</SwitchPrimitive.Root>
	)
}

export { Switch }
