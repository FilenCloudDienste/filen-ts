import { create } from "zustand"

interface ReminderState {
	keysDismissed: boolean
	storageDismissed: boolean
	// A storage-full refusal asked for the dialog; cleared when it closes.
	storageFullRequested: boolean
	dismissKeys: () => void
	dismissStorage: () => void
	closeStorageFull: () => void
}

// Which startup reminders (accountReminders.tsx) were dismissed this page load. Module state, so a
// reload re-arms them and a remount within the load keeps them down; web has no lock to hang a
// "once per unlock" rule on.
export const useReminderStore = create<ReminderState>(set => ({
	keysDismissed: false,
	storageDismissed: false,
	storageFullRequested: false,
	dismissKeys: () => {
		set({ keysDismissed: true })
	},
	dismissStorage: () => {
		set({ storageDismissed: true })
	},
	closeStorageFull: () => {
		set({ storageFullRequested: false })
	}
}))

// Raises the storage-full dialog (accountReminders.tsx) from anywhere, e.g. after the server refused an
// upload for storage. A request while it is already up is the same occurrence, so it never stacks.
export function openStorageFull(): void {
	if (!useReminderStore.getState().storageFullRequested) {
		useReminderStore.setState({ storageFullRequested: true })
	}
}
