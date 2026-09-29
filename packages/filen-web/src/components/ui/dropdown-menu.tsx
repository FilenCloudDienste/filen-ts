"use client"

import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@filen/shared"
import { stopRowPropagation } from "@/lib/domEvents"
import { ChevronRightIcon, CheckIcon } from "lucide-react"
import { MENU_POPUP_CLASS } from "@/components/ui/menuStyles"

const CHECK_ITEM_CLASS =
	"relative flex min-h-7 items-center gap-2 rounded-xl py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

const CHECK_INDICATOR_CLASS = "pointer-events-none absolute right-2 flex items-center justify-center"

const DropdownMenu = MenuPrimitive.Root

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return (
		<MenuPrimitive.Trigger
			data-slot="dropdown-menu-trigger"
			{...props}
		/>
	)
}

function DropdownMenuContent({
	align: alignProp,
	alignOffset: alignOffsetProp,
	side: sideProp,
	sideOffset: sideOffsetProp,
	className,
	...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
	// Not destructuring defaults, which the React Compiler cannot lower.
	const align = alignProp ?? "start"
	const alignOffset = alignOffsetProp ?? 0
	const side = sideProp ?? "bottom"
	const sideOffset = sideOffsetProp ?? 4

	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(MENU_POPUP_CLASS, "w-(--anchor-width) min-w-32 p-1 outline-none data-closed:overflow-hidden", className)}
					// Portaled, yet its clicks still bubble through the React tree into the row that mounts the menu.
					onClick={stopRowPropagation}
					onDoubleClick={stopRowPropagation}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	)
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return (
		<MenuPrimitive.Group
			data-slot="dropdown-menu-group"
			{...props}
		/>
	)
}

function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			className={cn("px-2 py-1 text-xs text-muted-foreground", className)}
			{...props}
		/>
	)
}

function DropdownMenuItem({
	className,
	variant: variantProp,
	...props
}: MenuPrimitive.Item.Props & {
	variant?: "default" | "destructive"
}) {
	// Not a destructuring default, which the React Compiler cannot lower.
	const variant = variantProp ?? "default"

	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-variant={variant}
			className={cn(
				"relative flex min-h-7 items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
				className
			)}
			{...props}
		/>
	)
}

const DropdownMenuSub = MenuPrimitive.SubmenuRoot

function DropdownMenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="dropdown-menu-sub-trigger"
			className={cn(
				"flex min-h-7 items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			{...props}
		>
			{children}
			<ChevronRightIcon className="ml-auto" />
		</MenuPrimitive.SubmenuTrigger>
	)
}

function DropdownMenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
	return (
		<DropdownMenuContent
			data-slot="dropdown-menu-sub-content"
			className={cn("w-auto min-w-[96px]", className)}
			alignOffset={-3}
			side="right"
			sideOffset={0}
			{...props}
		/>
	)
}

function DropdownMenuCheckboxItem({ className, children, checked, ...props }: MenuPrimitive.CheckboxItem.Props) {
	return (
		<MenuPrimitive.CheckboxItem
			data-slot="dropdown-menu-checkbox-item"
			className={cn(CHECK_ITEM_CLASS, className)}
			checked={checked}
			{...props}
		>
			<span
				className={CHECK_INDICATOR_CLASS}
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<CheckIcon />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</MenuPrimitive.CheckboxItem>
	)
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return (
		<MenuPrimitive.RadioGroup
			data-slot="dropdown-menu-radio-group"
			{...props}
		/>
	)
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			className={cn(CHECK_ITEM_CLASS, className)}
			{...props}
		>
			<span
				className={CHECK_INDICATOR_CLASS}
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<CheckIcon />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{children}
		</MenuPrimitive.RadioItem>
	)
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border/50", className)}
			{...props}
		/>
	)
}

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent
}
