import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "@filen/shared"
import { stopRowPropagation } from "@/lib/domEvents"
import { ChevronRightIcon, CheckIcon } from "lucide-react"
import { MENU_POPUP_CLASS } from "@/components/ui/menuStyles"

const ContextMenu = ContextMenuPrimitive.Root

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
	return (
		<ContextMenuPrimitive.Trigger
			data-slot="context-menu-trigger"
			className={cn("select-none", className)}
			{...props}
		/>
	)
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Positioner
				className="isolate z-50 outline-none"
				align="start"
				alignOffset={4}
				side="right"
				sideOffset={0}
			>
				<ContextMenuPrimitive.Popup
					data-slot="context-menu-content"
					className={cn(MENU_POPUP_CLASS, "min-w-36 p-1 outline-none", className)}
					// Portaled, yet its clicks still bubble through the React tree into the row that mounts the menu.
					onClick={stopRowPropagation}
					onDoubleClick={stopRowPropagation}
					{...props}
				/>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	)
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
	return (
		<ContextMenuPrimitive.Group
			data-slot="context-menu-group"
			{...props}
		/>
	)
}

function ContextMenuLabel({ className, ...props }: ContextMenuPrimitive.GroupLabel.Props) {
	return (
		<ContextMenuPrimitive.GroupLabel
			data-slot="context-menu-label"
			className={cn("px-2 py-1 text-xs text-muted-foreground", className)}
			{...props}
		/>
	)
}

function ContextMenuItem({
	className,
	variant: variantProp,
	...props
}: ContextMenuPrimitive.Item.Props & {
	variant?: "default" | "destructive"
}) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const variant = variantProp ?? "default"

	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			data-variant={variant}
			className={cn(
				"relative flex min-h-7 items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-destructive",
				className
			)}
			{...props}
		/>
	)
}

const ContextMenuSub = ContextMenuPrimitive.SubmenuRoot

function ContextMenuSubTrigger({ className, children, ...props }: ContextMenuPrimitive.SubmenuTrigger.Props) {
	return (
		<ContextMenuPrimitive.SubmenuTrigger
			data-slot="context-menu-sub-trigger"
			className={cn(
				"flex min-h-7 items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			{...props}
		>
			{children}
			<ChevronRightIcon className="ml-auto" />
		</ContextMenuPrimitive.SubmenuTrigger>
	)
}

function ContextMenuSubContent({ ...props }: React.ComponentProps<typeof ContextMenuContent>) {
	return (
		<ContextMenuContent
			data-slot="context-menu-sub-content"
			{...props}
		/>
	)
}

function ContextMenuCheckboxItem({ className, children, checked, ...props }: ContextMenuPrimitive.CheckboxItem.Props) {
	return (
		<ContextMenuPrimitive.CheckboxItem
			data-slot="context-menu-checkbox-item"
			className={cn(
				"relative flex min-h-7 items-center gap-2 rounded-xl py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			checked={checked}
			{...props}
		>
			<span className="pointer-events-none absolute right-2">
				<ContextMenuPrimitive.CheckboxItemIndicator>
					<CheckIcon />
				</ContextMenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</ContextMenuPrimitive.CheckboxItem>
	)
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
	return (
		<ContextMenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border/50", className)}
			{...props}
		/>
	)
}

export {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuCheckboxItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuGroup,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger
}
