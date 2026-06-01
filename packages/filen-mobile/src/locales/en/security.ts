// Security feature vocabulary (src/routes/security/index.tsx, biometric.tsx, twoFactor.tsx).
// Shared keys (cancel, continue, save, close, enable, disable, copy, copied_to_clipboard)
// live in common.ts and must not be redefined here.
export const security = {
	// ── Security screen ────────────────────────────────────────────────────────
	/** Security settings screen — header/page title */
	security: "Security",

	// ── Change password ────────────────────────────────────────────────────────
	/** Change-password row — title and dialog title */
	change_password: "Change password",
	/** Change-password row — subtitle describing the action */
	change_password_description: "Update your account password",
	/** Change-password dialog — message asking for the new password */
	enter_new_password: "Enter your new password",
	/** Change-password dialog — message asking the user to confirm the new password */
	enter_confirm_new_password: "Confirm your new password",
	// passwords_do_not_match lives in common.ts.
	/** Change-password dialog — message asking for the current (existing) password */
	enter_current_password: "Enter your current password",
	/** Change-password dialog — confirm button that submits the password change */
	change: "Change",
	/** Toast shown after a password change has been applied successfully */
	password_changed_successfully: "Password changed successfully",

	// ── Two-factor authentication (settings row + twoFactor screen) ───────────
	/** Two-factor authentication row and screen — title */
	two_factor_authentication: "Two-factor authentication",
	/** Two-factor authentication row — subtitle describing the feature */
	two_factor_authentication_description: "Require a code from your authenticator app at sign-in",
	/** Disable-2FA confirmation dialog — title */
	disable_two_factor_authentication: "Disable two-factor authentication",
	/** Disable-2FA confirmation dialog — message warning about the security implication */
	disable_two_factor_authentication_description:
		"Are you sure you want to disable two-factor authentication? Your account will be less secure.",
	/** 2FA code-entry dialog — title shown when asking for the current TOTP code */
	enter_two_factor_code: "Enter two-factor code",
	/** 2FA code-entry dialog — message instructing the user to open their authenticator app */
	enter_two_factor_code_description: "Open your authenticator app and enter the six-digit code",
	/** Recovery-key dialog — title shown after enabling 2FA, presenting the recovery key */
	two_factor_recovery_key: "Recovery key",
	/**
	 * Recovery-key dialog — message body advising the user to save the key.
	 * NOTE: The original source set BOTH okText AND cancelText to the same "continue" placeholder
	 * (line ~214), which looks like a copy-paste bug. okText now maps to common "continue";
	 * cancelText maps to common "close" (a sensible dismiss action for an informational dialog).
	 */
	two_factor_recovery_key_description:
		"Save your recovery key somewhere safe. You will need it if you ever lose access to your authenticator app.",
	/** Toast shown after the 2FA TOTP secret has been copied to the clipboard */
	secret_copied_to_clipboard: "Secret copied to clipboard",
	/** Button label that copies the TOTP secret key to the clipboard */
	copy_secret: "Copy secret",

	// ── Biometric authentication (settings row + biometric screen) ────────────
	/** Biometric authentication row and screen — title */
	biometric_authentication: "Biometric authentication",
	/** Biometric authentication row — subtitle describing the feature */
	biometric_authentication_description: "Unlock the app with Face ID, Touch ID, or your device PIN",
	/**
	 * Confirmation dialog title shown when enabling biometrics would disable the
	 * File / Documents Provider (the two cannot be active simultaneously).
	 */
	biometric_disables_file_provider_title: "Disable file provider",
	/**
	 * Confirmation dialog message explaining why enabling biometrics disables the file provider.
	 * The native provider extensions bypass the JS biometric gate, so both cannot be active.
	 */
	biometric_disables_file_provider_message:
		"Enabling biometric authentication will disable the file provider, because the provider bypasses the lock screen. Do you want to continue?",
	/** Fallback-password dialog — title shown when setting the PIN/password fallback for biometrics */
	fallback_password: "Fallback password",
	/** Fallback-password dialog — message asking the user to set a fallback password */
	enter_fallback_password: "Enter a fallback password used when biometrics are unavailable",
	/** Fallback-password confirm dialog — message asking the user to re-enter the fallback password */
	enter_confirm_fallback_password: "Confirm your fallback password",
	/** Inline error shown when the two fallback-password fields do not match */
	fallback_passwords_do_not_match: "Fallback passwords do not match",
	/** Biometric settings row — title for the PIN-only toggle */
	pin_only: "PIN only",
	/** Biometric settings row — subtitle describing the PIN-only mode */
	pin_only_description: "Use only your PIN instead of biometrics to unlock",
	/** Biometric settings row — title for the lock-after-inactivity picker */
	lock_app_after: "Lock app after",
	/** Biometric settings row — subtitle shown when no specific timeout is selected */
	lock_app_after_description: "Choose when to lock the app after inactivity",
	/** Lock-after action-sheet option: lock immediately when the app goes to background */
	immediately: "Immediately",
	/** Lock-after action-sheet option: lock after one minute of inactivity */
	one_minute: "1 minute",
	/** Lock-after action-sheet option: lock after five minutes of inactivity */
	five_minutes: "5 minutes",
	/** Lock-after action-sheet option: lock after fifteen minutes of inactivity */
	fifteen_minutes: "15 minutes",
	/** Lock-after action-sheet option: lock after thirty minutes of inactivity */
	thirty_minutes: "30 minutes",
	// one_hour lives in common.ts.
	/** Empty-state message shown when the device has no biometric hardware or is not enrolled */
	biometric_not_supported:
		"Biometric authentication is not supported on this device or no biometric method is enrolled.",

	// ── Export master keys ─────────────────────────────────────────────────────
	/** Export-master-keys row and dialog — title */
	export_master_keys: "Export master keys",
	/** Export-master-keys row — subtitle summarising the purpose */
	export_master_keys_description: "Back up your master keys for account recovery",
	/**
	 * Export-master-keys confirmation dialog — message body explaining why master keys
	 * are critical for password-reset and full account recovery.
	 */
	export_master_keys_needed_for_recovery:
		"Your master keys are required to recover your account if you forget your password. Export and store them somewhere safe."
} as const
