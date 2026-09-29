import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@filen/shared"
import { FIELD_CONTROL_CLASS, INVALID_RING_CLASS } from "@/components/ui/surface"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				"h-8 w-full min-w-0 px-2.5 py-1 text-base file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none md:text-sm",
				FIELD_CONTROL_CLASS,
				INVALID_RING_CLASS,
				className
			)}
			{...props}
		/>
	)
}

export { Input }
