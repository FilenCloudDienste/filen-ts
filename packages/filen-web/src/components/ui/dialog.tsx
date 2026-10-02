import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useTranslation } from "react-i18next"

import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { SCRIM_CLASS } from "@/components/ui/surface"
import { XIcon } from "lucide-react"

const Dialog = DialogPrimitive.Root

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return (
		<DialogPrimitive.Portal
			data-slot="dialog-portal"
			{...props}
		/>
	)
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-overlay"
			// Local addition (keep across a shadcn regen): Base UI skips a nested dialog's backdrop, which
			// left a dialog opened over another (rename over a preview, a confirm over a picker) on an
			// undimmed parent. Each level brings its own scrim instead.
			forceRender
			className={cn(SCRIM_CLASS, className)}
			{...props}
		/>
	)
}

function DialogContent({
	className,
	children,
	closeButtonDisabled: closeButtonDisabledProp,
	...props
}: DialogPrimitive.Popup.Props & {
	// Local addition (not registry stock — keep across a shadcn regen): pending-gated dialogs
	// disable the X while their operation runs.
	closeButtonDisabled?: boolean
}) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const closeButtonDisabled = closeButtonDisabledProp ?? false
	// Localized: src/locales/en/common.ts `close` key — a shadcn regen of this registry file must
	// keep this call, not revert it to the literal "Close" string.
	const { t } = useTranslation("common")
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(
					"fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-[min(var(--radius-4xl),24px)] bg-popover p-6 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/5 duration-100 outline-none sm:max-w-md dark:ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
					className
				)}
				{...props}
			>
				{children}
				<DialogPrimitive.Close
					data-slot="dialog-close"
					disabled={closeButtonDisabled}
					render={
						<Button
							variant="ghost"
							className="absolute top-4 right-4 bg-secondary"
							size="icon-sm"
						/>
					}
				>
					<XIcon />
					<span className="sr-only">{t("close")}</span>
				</DialogPrimitive.Close>
			</DialogPrimitive.Popup>
		</DialogPortal>
	)
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-1.5", className)}
			{...props}
		/>
	)
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
			{...props}
		/>
	)
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("font-heading text-base leading-none font-medium", className)}
			{...props}
		/>
	)
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground", className)}
			{...props}
		/>
	)
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle }
