import { create } from "zustand"

interface ReminderState {
	keysDismissed: boolean
	storageDismissed: boolean
	// A storage-full refusal asked for the dialog; cleared when it closes.
	storageFullRequested: boolean
	// What the refusal said beyond the dialog's own words (how much was needed, how much is free).
	storageFullDetail: string | null
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
	storageFullDetail: null,
	dismissKeys: () => {
		set({ keysDismissed: true })
	},
	dismissStorage: () => {
		set({ storageDismissed: true })
	},
	closeStorageFull: () => {
		set({ storageFullRequested: false, storageFullDetail: null })
	}
}))

// Raises the storage-full dialog (accountReminders.tsx) from anywhere: the one surface every storage refusal shows,
// an upload's pre-flight or the server's. A request while it is already up is the same occurrence, so it never
// stacks; a `detail` it brings replaces the one shown.
export function openStorageFull(detail?: string): void {
	const state = useReminderStore.getState()

	if (!state.storageFullRequested || (detail !== undefined && detail !== state.storageFullDetail)) {
		useReminderStore.setState({ storageFullRequested: true, ...(detail === undefined ? {} : { storageFullDetail: detail }) })
	}
}
