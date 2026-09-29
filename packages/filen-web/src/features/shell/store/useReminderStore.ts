import { create } from "zustand"

interface ReminderState {
	keysDismissed: boolean
	storageDismissed: boolean
	dismissKeys: () => void
	dismissStorage: () => void
}

// Which startup reminders (accountReminders.tsx) were dismissed this page load. Module state, so a
// reload re-arms them and a remount within the load keeps them down; web has no lock to hang a
// "once per unlock" rule on.
export const useReminderStore = create<ReminderState>(set => ({
	keysDismissed: false,
	storageDismissed: false,
	dismissKeys: () => {
		set({ keysDismissed: true })
	},
	dismissStorage: () => {
		set({ storageDismissed: true })
	}
}))
