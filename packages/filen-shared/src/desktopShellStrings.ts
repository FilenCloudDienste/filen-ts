/**
 * The desktop shell's own text (macOS menu, tray, main-process notifications and dialogs), in English. The web app's
 * settings catalog spreads these keys so they are translated with the rest of the UI; the page sends main the text
 * in the chosen language (DesktopApp.setShellStrings) and main falls back to these. `{{name}}` placeholders follow
 * i18next's syntax. Import-free; reachable only through "@filen/shared/desktopShellStrings".
 */
export const DESKTOP_SHELL_STRINGS = {
	/** macOS app menu item that opens Settings; the ellipsis marks that it opens a window. */
	shellMenuSettings: "Settings…",
	/** macOS Help menu item that lists the keyboard shortcuts. */
	shellMenuShortcuts: "Keyboard Shortcuts",
	/** macOS View menu item that switches between the light and dark theme. */
	shellMenuToggleTheme: "Toggle Theme",
	/** macOS View menu item that shows or hides the assistant panel. */
	shellMenuToggleAssistant: "Toggle Assistant",
	/** macOS View menu item that opens the transfers list. */
	shellMenuTransfers: "Transfers",
	/** Menu and tray item that locks the app behind its PIN right away. */
	shellLock: "Lock Filen",
	/** macOS Help menu item that opens the Filen website in the browser. */
	shellWebsite: "Filen Website",
	/** Tray menu item that brings the app window to the front. */
	shellOpen: "Open Filen",
	/** Tray menu item that quits the app. */
	shellQuit: "Quit Filen",
	/** Tray menu item that opens the mounted network drive in the file manager. */
	shellOpenNetworkDrive: "Open network drive",
	/** Tray status line: the sync engine stopped after an error. */
	shellTraySyncStopped: "Sync stopped",
	/** Tray status line: a sync pair waits for the user (a conflict, held deletions). */
	shellTraySyncAttention: "Sync needs attention",
	/** Tray status line while files are syncing. */
	shellTraySyncing: "Syncing…",
	/** Tray status line when every sync pair is in sync. */
	shellTraySyncUpToDate: "Sync up to date",
	/** Tray status line: a mount (network drive or a server) failed. */
	shellTrayMountsAttention: "Mounts need attention",
	/** Tray status line while the network drive still uploads files written to it. */
	shellTrayDriveUploading: "Uploading from the network drive…",
	/** Tray status line naming where the network drive is mounted; {{path}} is a drive letter or a directory path. */
	shellTrayDriveMounted: "Network drive: mounted at {{path}}",
	/** Notification: the sync engine stopped after an error. */
	shellNotifySyncStopped: "Sync stopped. Open Filen to see why.",
	/** Notification: a sync pair waits for the user (a conflict, held deletions). */
	shellNotifySyncAttention: "A sync pair needs your attention.",
	/** Notification: several mounts stopped at once. */
	shellNotifyMountsStopped: "Mounts stopped. Open Filen to see why.",
	/** Notification: the network drive mount stopped. */
	shellNotifyDriveStopped: "The network drive stopped. Open Filen to see why.",
	/** Notification: the local WebDAV server stopped. */
	shellNotifyWebdavStopped: "The WebDAV server stopped. Open Filen to see why.",
	/** Notification: the local S3 server stopped. */
	shellNotifyS3Stopped: "The S3 server stopped. Open Filen to see why.",
	/** Notification: the local FTP server stopped. */
	shellNotifyFtpStopped: "The FTP server stopped. Open Filen to see why.",
	/** Notification: the local SFTP server stopped. */
	shellNotifySftpStopped: "The SFTP server stopped. Open Filen to see why.",
	/** Notification: the local HTTP server stopped. */
	shellNotifyHttpStopped: "The HTTP server stopped. Open Filen to see why.",
	/** Notification: the local restic server stopped. */
	shellNotifyResticStopped: "The restic server stopped. Open Filen to see why.",
	/** Notification: the local NFS server stopped. */
	shellNotifyNfsStopped: "The NFS server stopped. Open Filen to see why.",
	/** Dialog title when signing out while the network drive still uploads. */
	shellSignOutUploadingTitle: "The network drive is still uploading",
	/** Dialog body when signing out while one file still uploads from the network drive. */
	shellSignOutUploadingDetail_one: "{{count}} file is not uploaded yet. If you sign out now, it finishes uploading when you sign in again.",
	/** Dialog body when signing out while several files still upload from the network drive. */
	shellSignOutUploadingDetail_other:
		"{{count}} files are not uploaded yet. If you sign out now, they finish uploading when you sign in again.",
	/** Dialog button that keeps the user signed in until uploads finish. */
	shellWait: "Wait",
	/** Dialog button that signs out anyway. */
	shellSignOut: "Sign out",
	/** Dialog button that closes the dialog without doing anything. */
	shellCancel: "Cancel",
	/** Dialog title: an app update was downloaded but its installer did not start. */
	shellUpdateFailedTitle: "The update could not be installed",
	/** Dialog body under shellUpdateFailedTitle. */
	shellUpdateFailedDetail: "Filen keeps running on this version and tries again later.",
	/** Dialog title when quitting, leaving or restarting while work would be lost. */
	shellBusyTitle: "Filen is still working",
	/** Dialog body under shellBusyTitle. */
	shellBusyDetail: "Transfers are running or changes are not saved yet. They stop if you continue.",
	/** Dialog button that quits the app anyway. */
	shellBusyQuit: "Quit",
	/** Dialog button that leaves the page anyway (the window closes or navigates). */
	shellBusyLeave: "Leave",
	/** Dialog button that restarts the app anyway. */
	shellBusyRestart: "Restart",
	/** Save dialog title for exporting the app's diagnostic logs. */
	shellExportLogsTitle: "Export logs",
	/** File type name in the save dialog's filter for .txt files. */
	shellTextFiles: "Text",
	/** Error dialog shown when the app fails to start; the technical error follows on the next lines. */
	shellStartFailed: "Filen could not start.",
	/** Directory chooser title when adding a sync pair. */
	shellChooseSyncDirectory: "Choose a directory to sync",
	/** Directory chooser title when picking where the network drive is mounted. */
	shellChooseMountPoint: "Choose where to mount the network drive",
	/** macOS File menu item that closes the open dialog (a file preview), or the window when none is open. */
	shellMenuClose: "Close",
	/** macOS menu bar menu holding the audio player's transport (play, pause, next, previous). */
	shellMenuControls: "Controls",
	/** Controls menu and tray menu item that starts or resumes the audio player. */
	shellPlay: "Play",
	/** Controls menu and tray menu item that pauses the audio player. */
	shellPause: "Pause",
	/** Controls menu and tray menu item that skips to the next track. */
	shellNextTrack: "Next Track",
	/** Controls menu and tray menu item that goes back to the previous track. */
	shellPreviousTrack: "Previous Track"
} as const

export type DesktopShellStringKey = keyof typeof DESKTOP_SHELL_STRINGS

export type DesktopShellStrings = Record<DesktopShellStringKey, string>

export const DESKTOP_SHELL_STRING_KEYS = Object.keys(DESKTOP_SHELL_STRINGS) as DesktopShellStringKey[]

// What the page sends main: the UI language and its text per key, plural keys in every form the language selects
// (`shellSignOutUploadingDetail_few`). Main falls back to English for any key it lacks.
export interface DesktopShellStringsPayload {
	language: string
	strings: Record<string, string>
}

// Longest text main accepts per string from the page.
export const DESKTOP_SHELL_STRING_MAX_LENGTH = 512

/** `{{name}}` placeholders filled from `values`; an unknown placeholder stays as written. */
export function formatShellString(template: string, values: Readonly<Record<string, string | number>>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
		const value = values[name]

		return value === undefined ? match : String(value)
	})
}
