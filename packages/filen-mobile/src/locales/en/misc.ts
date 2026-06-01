// Miscellaneous cross-cutting UI vocabulary for root-layout background components and the
// rich-text editor toolbar:
//   - accountReminders.tsx  (master-keys export reminder, storage-exceeded notice)
//   - biometric.tsx         (biometric / PIN unlock overlay)
//   - cannotDecryptScreen.tsx (decryption-failure body copy)
//   - offlineBanner.tsx     (offline / back-online indicator)
//   - textEditor/richText/toolbar.tsx (link editor prompts + format menu labels)
// Shared keys (cancel, close, open, edit, remove, later, ok) live in common.ts and must not be
// redefined here.
export const misc = {
	// ── Account reminders (accountReminders.tsx) ──────────────────────────────
	/** Reminder dialog title prompting the user to export (back up) their master keys */
	master_keys_reminder_title: "Back up your master keys",
	/** Reminder dialog message explaining why exporting master keys matters; shown when the user has never exported them */
	master_keys_reminder_message:
		"Your master keys are the only way to recover your data if you forget your password. Export and store them somewhere safe.",
	/** Reminder dialog confirm button that opens the security screen to export master keys now */
	export_now: "Export now",
	/** Dialog title shown when the account has used more storage than its plan allows */
	storage_exceeded_title: "Storage limit reached",
	/** Dialog message shown when storage is over the limit; tells the user to free up space or upgrade */
	storage_exceeded_message:
		"You've reached your storage limit. Delete some files or upgrade your plan to keep uploading.",

	// ── Biometric / PIN unlock overlay (biometric.tsx) ────────────────────────
	/** Biometric prompt title and lock-overlay heading: asks the user to authenticate */
	authenticate: "Authenticate",
	/** Biometric system-prompt description explaining why authentication is required */
	authenticate_to_access_app: "Authenticate to access the app",
	/** Lock-overlay subtitle prompting the user to unlock to continue using the app */
	unlock_to_continue: "Unlock to continue",
	/** Action / fallback button label that switches from biometrics to PIN entry */
	use_pin: "Use PIN",
	/** PIN prompt title */
	pin_code: "PIN",
	/** PIN prompt message asking the user to enter their PIN */
	enter_pin: "Enter your PIN",
	/** Error toast shown after an incorrect PIN is entered */
	invalid_pin: "Incorrect PIN",
	/** Lock-overlay heading shown while the app is temporarily locked after failed attempts */
	app_locked: "App locked",
	/** Lock-overlay subtitle explaining the temporary lock is due to too many failed attempts */
	too_many_failed_attempts: "Too many failed attempts. Please try again shortly.",

	// ── Offline banner (offlineBanner.tsx) ────────────────────────────────────
	/** Global banner text shown while the device has no internet connection */
	youre_offline: "You're offline",
	/** Global banner text shown briefly after the connection is restored */
	back_online: "Back online",

	// ── Cannot-decrypt screen (cannotDecryptScreen.tsx) ───────────────────────
	/** Explanatory body shown under a "could not decrypt" placeholder, telling the user the item couldn't be decrypted on this device */
	cannot_decrypt_body: "This item couldn't be decrypted. It may have been created with a different account or key.",

	// ── Rich-text editor: link prompts (textEditor/richText/toolbar.tsx) ──────
	/** Dialog title for editing the URL of an existing link */
	edit_link: "Edit link",
	/** Dialog title for inserting a new link */
	insert_link: "Insert link",
	/** Dialog message for the link editor, asking the user to enter a web address */
	enter_url: "Enter a URL",
	/** Placeholder example URL shown in the link input field */
	url_placeholder: "https://example.com",
	/** Confirm button for the insert-link dialog */
	insert: "Insert",

	// ── Rich-text editor: format menu labels (textEditor/richText/toolbar.tsx) ─
	/** Header-style menu item that removes heading formatting (back to normal paragraph text) */
	normal: "Normal",
	/** List-style menu item: numbered / ordered list */
	ordered_list: "Numbered list",
	/** List-style menu item: bulleted list */
	bullet_list: "Bulleted list",
	/** List-style menu item: checklist (tappable checkboxes) */
	checklist: "Checklist"
} as const
