import { create } from "zustand"

// Whether the shortcuts dialog (shortcutsHost) is open.
export const useShortcutsDialogStore = create<{ open: boolean }>(() => ({ open: false }))

// The account menu's entry and the macOS Help menu open the same dialog the key does.
export function openShortcutsDialog(): void {
	useShortcutsDialogStore.setState({ open: true })
}

export function setShortcutsDialogOpen(open: boolean): void {
	useShortcutsDialogStore.setState({ open })
}
