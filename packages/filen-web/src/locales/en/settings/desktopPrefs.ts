// "settings" namespace — the desktop-only settings (app lock timeout, notification toggles, download directory). Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsDesktopPrefs = {
	// ── Notifications ─────────────────────────────────────────────────────
	/** Desktop settings — toggle: OS notifications for new chat messages */
	settingsDesktopChatNotifications: "Chat messages",
	settingsDesktopChatNotificationsDescription:
		"Notify you of new messages while Filen is in the background. Filen stays loaded in the background to receive them.",
	/** Desktop settings — toggle: OS notifications for incoming contact requests */
	settingsDesktopContactNotifications: "Contact requests",
	settingsDesktopContactNotificationsDescription:
		"Notify you of new contact requests while Filen is in the background. Filen stays loaded in the background to receive them.",
	/** Desktop settings — toggle: OS notifications when a sync pair needs attention or sync, the network drive or a local server stops */
	settingsDesktopSyncNotifications: "Sync and drive alerts",
	settingsDesktopSyncNotificationsDescription:
		"Notify you when a sync needs your attention, or when sync, the network drive or a server stops.",
	/** Desktop settings — toggle: notifications play the operating system's notification sound */
	settingsDesktopNotificationSound: "Notification sound",
	settingsDesktopNotificationSoundDescription: "Play your system's notification sound with each notification.",

	// ── Downloads ─────────────────────────────────────────────────────────
	/** Desktop settings — group title: where downloads are saved */
	settingsDesktopDownloadsTitle: "Downloads",
	/** Desktop settings — row label; its value is a directory path or "Ask every time" */
	settingsDesktopDownloadLocation: "Save downloads to",
	settingsDesktopDownloadLocationDescription: "Where downloaded files and directories are saved.",
	/** Desktop settings — the download location's value when none is set, and the button that clears a set one */
	settingsDesktopDownloadAsk: "Ask every time",
	/** Desktop settings — button: opens a directory picker for the download location */
	settingsDesktopDownloadChange: "Change…",
	/** Toast: the directory picker for the download location failed */
	settingsDesktopDownloadChooseFailed: "Couldn't change the download directory",

	// ── App lock: lock after ──────────────────────────────────────────────
	/** Desktop settings, App lock group — select: how long without use before Filen locks itself */
	settingsDesktopLockAfter: "Lock after",
	settingsDesktopLockAfterDescription:
		"Lock Filen when you haven't used it for this long, including while its window is hidden. Filen also locks when it opens and when you lock your computer.",
	/** Desktop settings — "Lock after" option: never lock on inactivity */
	settingsDesktopLockAfterNever: "Never",
	/** Desktop settings — "Lock after" option, a number of minutes */
	settingsDesktopLockAfterMinutes_one: "{{count}} minute",
	settingsDesktopLockAfterMinutes_other: "{{count}} minutes",
	/** Desktop settings — "Lock after" option, a number of hours */
	settingsDesktopLockAfterHours_one: "{{count}} hour",
	settingsDesktopLockAfterHours_other: "{{count}} hours"
} as const
