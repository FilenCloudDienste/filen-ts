"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@filen/shared"

const Popover = PopoverPrimitive.Root

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return (
		<PopoverPrimitive.Trigger
			data-slot="popover-trigger"
			{...props}
		/>
	)
}

function PopoverContent({
	className,
	align: alignProp,
	side: sideProp,
	...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "align" | "side">) {
	// Not destructuring defaults, which the React Compiler cannot lower.
	const align = alignProp ?? "center"
	const side = sideProp ?? "bottom"

	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={0}
				side={side}
				sideOffset={4}
				className="isolate z-50"
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						"z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-3xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
						className
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	)
}

export { Popover, PopoverContent, PopoverTrigger }
