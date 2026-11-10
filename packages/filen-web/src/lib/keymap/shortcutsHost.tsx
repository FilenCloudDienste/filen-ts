import { ShortcutsDialog } from "@/lib/keymap/shortcutsDialog"
import { openShortcutsDialog, setShortcutsDialogOpen, useShortcutsDialogStore } from "@/lib/keymap/shortcutsDialogStore"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"

// The shortcuts dialog for every page: the app, sign-in and public links alike. Mounted once at the root. An open
// dialog or menu owns the keyboard, so the dialog never stacks on top of one.
export function ShortcutsHost() {
	const open = useShortcutsDialogStore(state => state.open)

	useAction("app.openShortcuts", openShortcutsDialog, OUTSIDE_OVERLAYS)

	return (
		<ShortcutsDialog
			open={open}
			onOpenChange={setShortcutsDialogOpen}
		/>
	)
}
