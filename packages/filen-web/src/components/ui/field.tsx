import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@filen/shared"
import { Label } from "@/components/ui/label"

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="field-group"
			className={cn("group/field-group flex w-full flex-col gap-6 *:data-[slot=field-group]:gap-4", className)}
			{...props}
		/>
	)
}

const fieldVariants = cva("group/field flex w-full gap-3 data-[invalid=true]:text-destructive", {
	variants: {
		orientation: {
			vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
			horizontal:
				"flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px"
		}
	},
	defaultVariants: {
		orientation: "vertical"
	}
})

function Field({ className, orientation: orientationProp, ...props }: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const orientation = orientationProp === undefined ? "vertical" : orientationProp

	return (
		<div
			role="group"
			data-slot="field"
			data-orientation={orientation}
			className={cn(fieldVariants({ orientation }), className)}
			{...props}
		/>
	)
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="field-content"
			className={cn("group/field-content flex flex-1 flex-col gap-1 leading-snug", className)}
			{...props}
		/>
	)
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
	return (
		<Label
			data-slot="field-label"
			className={cn(
				"group/field-label peer/field-label flex w-fit gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:bg-input/30 has-[>[data-slot=field]]:rounded-2xl has-[>[data-slot=field]]:border *:data-[slot=field]:p-4",
				"has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
				className
			)}
			{...props}
		/>
	)
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
	return (
		<p
			data-slot="field-description"
			className={cn(
				"text-left text-sm leading-normal font-normal text-muted-foreground group-has-data-horizontal/field:text-balance",
				"last:mt-0 nth-last-2:-mt-1",
				"[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
				className
			)}
			{...props}
		/>
	)
}

function FieldError({ className, children, ...props }: React.ComponentProps<"div">) {
	if (!children) {
		return null
	}

	return (
		<div
			role="alert"
			data-slot="field-error"
			className={cn("text-sm font-normal text-destructive", className)}
			{...props}
		>
			{children}
		</div>
	)
}

export { Field, FieldLabel, FieldDescription, FieldError, FieldGroup, FieldContent }
