// English source catalog — "desktop" namespace: copy only the desktop app shows (its lock screen, the
// Settings > Desktop app lock and log export, its update prompt). Same typed-catalog rules as every other
// namespace: flat `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces,
// keySeparator/nsSeparator both ON). "directory" never "folder".
export const desktop = {
	// ── Lock screen ─────────────────────────────────────────────────────
	/** Lock screen — heading */
	lockTitle: "Filen is locked",
	/** Lock screen — under the heading; mounts and sync are the desktop app's background work */
	lockDescription: "Enter your PIN to unlock. Background sync and drives keep running while Filen is locked.",
	/** Lock screen — accessible name of the PIN field */
	lockPinLabel: "PIN",
	/** Lock screen — submit button */
	lockUnlock: "Unlock",
	/** Lock screen — the PIN entered was wrong */
	lockWrongPin: "Wrong PIN. Try again.",
	/** Lock screen and PIN dialogs — too many wrong PINs; {{time}} is a m:ss countdown */
	lockRetryIn: "Too many wrong PINs. Try again in {{time}}.",
	/** Lock screen — the PIN could not be checked (main refused or failed) */
	lockFailed: "Couldn't check the PIN. Try again.",
	/** Lock screen — a PIN is set but cannot be read (locked system keychain, damaged file) */
	lockUnreadable: "Filen couldn't read its PIN. Unlock your system keychain and try again, or sign out.",
	/** Lock screen — retry reading the PIN */
	lockTryAgain: "Try again",
	/** Lock screen — link to the sign-out path for a forgotten PIN */
	lockForgotPin: "Forgot your PIN?",
	/** Lock screen — confirmation before signing out to remove a forgotten PIN */
	lockSignOutBody:
		"Signing out removes the PIN and Filen's data on this device, including changes that haven't synced yet. Sign in again with your password.",
	/** Lock screen — confirm button of the forgotten-PIN sign-out */
	lockSignOut: "Sign out",
	/** Lock screen — the forgotten-PIN sign-out failed before anything was removed */
	lockSignOutFailed: "Couldn't sign out. Try again.",

	// ── Unreadable saved sign-in ────────────────────────────────────────
	/** Saved sign-in screen — heading; the stored session cannot be decrypted (locked or reset system keychain) */
	sessionUnreadableTitle: "Couldn't read your saved sign-in",
	/** Saved sign-in screen — under the heading */
	sessionUnreadableBody: "The saved sign-in could not be read. Unlock your system keychain and try again, or sign in again.",
	/** Saved sign-in screen — read the saved sign-in again */
	sessionUnreadableTryAgain: "Try again",
	/** Saved sign-in screen — the saved sign-in still could not be read after trying again */
	sessionUnreadableStill: "Still couldn't read it. Check that your system keychain is unlocked.",
	/** Saved sign-in screen — button, and the confirm button of its dialog: remove the saved sign-in and go to sign-in */
	sessionUnreadableSignIn: "Sign in again",
	/** Saved sign-in screen — confirm dialog title */
	sessionDiscardTitle: "Sign in again?",
	/** Saved sign-in screen — confirm dialog body; "servers" are the Mounts section's protocol servers */
	sessionDiscardBody:
		"The saved sign-in will be removed from this device. Files in your account are not affected. Credentials saved for your servers may need to be entered again.",
	/** Saved sign-in screen — removing the saved sign-in failed */
	sessionDiscardFailed: "Couldn't remove the saved sign-in. Try again.",

	// ── Settings > Desktop: app lock ────────────────────────────────────
	/** Settings > Desktop — app lock group title */
	settingsLockTitle: "App lock",
	/** Settings > Desktop — PIN row title */
	settingsLockPin: "PIN lock",
	/** Settings > Desktop — PIN row description */
	settingsLockPinDescription:
		"Ask for a PIN when Filen opens and after its window has been hidden for a few minutes. Background sync and drives keep running while Filen is locked.",
	/** Settings > Desktop — set a PIN (none set yet) */
	settingsLockSet: "Set PIN",
	/** Settings > Desktop — change the PIN */
	settingsLockChange: "Change",
	/** Settings > Desktop — remove the PIN */
	settingsLockRemove: "Remove",
	/** Settings > Desktop — lock-now row title */
	settingsLockNow: "Lock now",
	/** Settings > Desktop — lock-now row description */
	settingsLockNowDescription: "Lock Filen until the PIN is entered. You can also lock it from its tray or menu bar icon.",
	/** Settings > Desktop — lock-now button */
	settingsLockNowAction: "Lock",
	/** PIN dialog — title when setting a first PIN */
	pinSetTitle: "Set a PIN",
	/** PIN dialog — title when changing the PIN */
	pinChangeTitle: "Change PIN",
	/** PIN dialog — title when removing the PIN */
	pinRemoveTitle: "Remove PIN",
	/** PIN dialog — description for set and change; {{min}}-{{max}} are the allowed lengths */
	pinRulesDescription: "Use {{min}} to {{max}} digits. A forgotten PIN can only be removed by signing out.",
	/** PIN dialog — description when removing */
	pinRemoveDescription: "Enter your PIN to stop locking Filen.",
	/** PIN dialog — current PIN field */
	pinCurrent: "Current PIN",
	/** PIN dialog — new PIN field */
	pinNew: "New PIN",
	/** PIN dialog — repeat of the new PIN */
	pinConfirm: "Confirm PIN",
	/** PIN dialog — the two new PIN fields differ */
	pinMismatch: "The PINs don't match",
	/** PIN dialog — submit when setting or changing */
	pinSave: "Save PIN",
	/** PIN dialog — submit when removing */
	pinRemove: "Remove PIN",
	/** PIN dialog — the current PIN was wrong */
	pinWrong: "Wrong PIN",
	/** Toast after setting or changing the PIN */
	pinSaved: "PIN saved",
	/** Toast after removing the PIN */
	pinRemoved: "PIN removed",
	/** Toast when main refused or failed to store the PIN change */
	pinFailed: "Couldn't change the PIN",

	// ── Settings > Desktop: logs ────────────────────────────────────────
	/** Settings > Desktop — logs group title */
	settingsLogsTitle: "Troubleshooting",
	/** Settings > Desktop — export logs row title */
	settingsLogsExport: "Export logs",
	/** Settings > Desktop — export logs row description */
	settingsLogsExportDescription:
		"Save the app's diagnostic logs to a file you can send to support. Keys, passwords and other secrets are removed.",
	/** Settings > Desktop — export logs button */
	settingsLogsExportAction: "Export",
	/** Toast after the logs file was saved */
	logsExported: "Logs saved",
	/** Toast when the logs could not be saved */
	logsExportFailed: "Couldn't save the logs",

	// ── Update prompt ───────────────────────────────────────────────────
	/** Update toast — title once a new desktop version is downloaded */
	updateReadyTitle: "Update ready",
	/** Update toast — body; {{version}} is the downloaded version */
	updateReadyBody: "Filen {{version}} has been downloaded. Restart to install it.",
	/** Update toast — action that quits, installs and relaunches */
	updateRestart: "Restart"
} as const
