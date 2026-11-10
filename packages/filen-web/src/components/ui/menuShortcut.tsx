import { cn } from "@filen/shared"

// A menu item's key hint at its end, right-aligned after the label: shadcn's DropdownMenuShortcut and
// ContextMenuShortcut, one slot for both menu families. Holds the chips (lib/keymap/kbd.tsx's Kbd, KbdKeys) or a
// plain-text key; collapses when they render nothing (an unbound action), so an item never keeps an empty gap.
function MenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="menu-shortcut"
			className={cn("ml-auto inline-flex shrink-0 items-center pl-4 empty:hidden", className)}
			{...props}
		/>
	)
}

export { MenuShortcut }
