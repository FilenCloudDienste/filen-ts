// English source catalog — "auth" namespace: sign-in, registration, password-reset, and
// security-settings vocabulary for the login/register/reset/security screens. Mirrors
// filen-mobile's per-area-file convention (see filen-mobile/src/locales/en/auth.ts and
// security.ts) reshaped for this app's typed-catalog rules: flat `as const` object, camelCase
// keys, no literal '.' or ':' (this app runs real i18next namespaces with keySeparator/nsSeparator
// both ON, unlike mobile's single flat namespace).
//
// Naming law (binding across every screen that consumes this namespace): `recoveryKey` names the
// two-factor backup code ONLY — it is generated once when two-factor authentication is enabled and
// used to sign in if the authenticator app is lost. The exportMasterKeys() artifact is always
// `masterKeys…` in identifiers and i18n keys. Never blur the two.
//
// Split-sentence links (`dontHaveAccount`, `alreadyHaveAccount`) embed the tappable segment as an
// `<a>…</a>` placeholder for react-i18next's `<Trans>` component (`components={{ a: <Link .../> }}`).
// NOT `<link>` — react-i18next's HTML parser (html-parse-stringify, via the `void-elements` table)
// treats `<link>` as a void element like `<br>`/`<img>`, so `<link>Sign up</link>` silently drops
// its children: the anchor renders empty and "Sign up" lands as unlinked plain text after it
// (verified against a live build). Never use a tag name from the HTML void-elements list here
// (area/base/br/col/embed/hr/img/input/link/meta/param/source/track/wbr). Prefer the bound-`t` form
// (`const { t } = useTranslation("auth")` then `<Trans t={t} i18nKey="dontHaveAccount">`) — a
// cross-namespace `i18nKey="auth:key"` string does not infer cleanly under this app's typed
// `CustomTypeOptions`.
//
// The skip-keys stage-4 gate compares the typed value against the localized confirmation phrase
// (skipMasterKeysWarningTypedConfirmPhrase). The consumer resolves that key ONCE and feeds the
// same resolved string to both the visible copy ({{phrase}}) and the match check, so the displayed
// phrase and the compared phrase cannot drift — that same-source rule is TypedConfirmDialog's
// matchValue contract.
export const auth = {
	// ── Login screen ────────────────────────────────────────────────────────────
	/** Login screen — page title above the sign-in form */
	loginTitle: "Sign in to Filen",
	/** Login screen — subtitle under the title */
	loginSubtitle: "Your end-to-end encrypted drive, notes and chats.",
	/** Login screen — email field label */
	loginEmail: "Email",
	/** Login screen — email field placeholder */
	loginEmailPlaceholder: "you@example.com",
	/** Login screen — password field label */
	loginPassword: "Password",
	/** Login screen — submit button; also submits the two-factor step's retry once a code is entered */
	loginSubmit: "Sign in",
	/** Login screen — warning toast when sign-in succeeded but the session could not be saved on this device; the tab stays signed in, only resume after closing it is lost */
	sessionPersistFailed:
		"Signed in, but your session could not be saved on this device. You may need to sign in again after closing the tab.",
	/** Login screen — split-sentence link to the register screen; <a> wraps "Sign up" */
	dontHaveAccount: "Don't have an account? <a>Sign up</a>",

	// ── Two-factor step (shown during login when the account requires it) ──────
	/** Login two-factor step — title shown once the account requires a code */
	twoFactorTitle: "Two-factor authentication",
	/** Login two-factor step — body instructing the user to enter their authenticator code */
	twoFactorBody: "Enter the code from your authenticator app to finish signing in.",
	/** Shared field label for an authenticator-code input: login two-factor step, enabling/disabling two-factor authentication, and confirming account deletion */
	twoFactorCode: "Authenticator code",
	/** Login two-factor step — link that switches the code field to accept a recovery key instead */
	twoFactorUseRecoveryKey: "Use your recovery key instead",
	/** Login two-factor step — field label after switching to recovery-key mode (the two-factor backup code, never the exported master keys) */
	twoFactorRecoveryKeyInput: "Recovery key",
	/** Login two-factor step — inline error shown when the submitted code or recovery key is rejected */
	twoFactorWrongCode: "Incorrect code. Please try again.",

	// ── Forgot password (dialog opened from the login screen) ──────────────────
	/** Login screen — link that opens the forgot-password dialog */
	forgotPasswordLink: "Forgot password?",
	/** Forgot-password dialog — title */
	forgotPasswordTitle: "Reset password",
	/** Forgot-password dialog — body asking for the account email */
	forgotPasswordBody: "Enter your account email address and we'll send you a link to reset your password.",
	/** Forgot-password dialog — email field label */
	forgotPasswordEmail: "Email",
	/** Forgot-password dialog — submit button */
	forgotPasswordSubmit: "Send",
	/** Forgot-password dialog — non-revealing confirmation shown after submit; never confirms whether the account exists */
	passwordResetEmailSent: "If an account exists for that address, a password reset email has been sent.",

	// ── Register screen ─────────────────────────────────────────────────────────
	/** Register screen — page title */
	registerTitle: "Create your account",
	/** Register screen — subtitle under the title */
	registerSubtitle: "Sign up for a free Filen account.",
	/** Register screen — email field label */
	registerEmail: "Email",
	/** Register screen — email field placeholder */
	registerEmailPlaceholder: "you@example.com",
	/** Register screen — password field label */
	registerPassword: "Password",
	/** Register screen — confirm-password field label */
	registerConfirmPassword: "Confirm password",
	/** Register screen — submit button */
	registerSubmit: "Create account",
	/** Register screen — split-sentence link to the login screen; <a> wraps "Sign in" */
	alreadyHaveAccount: "Already have an account? <a>Sign in</a>",

	// ── Password strength meter (register + reset screens) ──────────────────────
	/** Password-strength rating: weakest tier */
	passwordStrengthWeak: "Weak",
	/** Password-strength rating: medium tier */
	passwordStrengthNormal: "Fair",
	/** Password-strength rating: strong tier */
	passwordStrengthStrong: "Strong",
	/** Password-strength rating: strongest tier */
	passwordStrengthBest: "Very strong",
	/** Helper line under the strength meter (register and reset forms) when the entered password is below the minimum strength required to submit; never names a specific tier */
	passwordStrengthTooWeak: "Choose a stronger password to continue",

	// ── Free-storage eligibility banner (register screen) ───────────────────────
	/** Register screen — eligibility banner shown when the region/IP IS eligible for the free-storage signup bonus */
	registerCheckEligible: "You are eligible for 10 GiB of free storage!",
	/** Register screen — link on the eligibility banner opening the explainer article */
	registerCheckLearnMore: "Learn more",

	// ── Post-register success panel / resend confirmation ───────────────────────
	/** Register success panel — message shown after registration succeeds; the confirmation link itself is homepage-owned, not a web-app route */
	accountCreatedCheckEmail: "Account created. Please check your email to confirm your address.",
	/** Register success panel — button that resends the confirmation email; no prompt, reuses the email already typed on the form */
	resendConfirmation: "Resend confirmation email",
	/** Register success panel — non-revealing toast after pressing resend; never confirms whether the account exists or is already confirmed */
	resendConfirmationSent: "If an account exists for that address, a confirmation email has been sent.",

	// ── Reset page (token-only: the user retypes their email, no prefill) ──────
	/** Reset page — page title */
	resetTitle: "Reset your password",
	/** Reset page — body explaining the page needs the account email plus a new password */
	resetBody: "Enter your account email and choose a new password.",
	/** Reset page — email field label (the reset link carries only a token; the user retypes their email) */
	resetEmail: "Email",
	/** Reset page — new-password field label */
	resetNewPassword: "New password",
	/** Reset page — confirm-new-password field label */
	resetConfirmPassword: "Confirm new password",
	/** Reset page — submit button */
	resetSubmit: "Reset password",

	// ── Master keys file upload (reset page) ────────────────────────────────────
	/** Reset page — file input label for the exported master keys file */
	masterKeysFileLabel: "Master keys file",
	/** Reset page — help text explaining what the master keys file is for and what skipping it costs */
	masterKeysFileHelp:
		"Upload the master keys file you exported from Security settings to keep access to your existing files, notes and chats. Skip this only if you no longer have it.",
	/** Reset page — button opening the file picker for the master keys file upload */
	masterKeysFileChoose: "Choose file",
	/** Reset page — shown next to the chosen file name once a master keys file has been read; {{fileName}} interpolates the chosen file's name */
	masterKeysFileImported: "Master keys imported ({{fileName}})",
	/** Reset page — accessible label on the button that removes the chosen master keys file, returning the reset to the no-file (skip-keys) path */
	masterKeysFileRemove: "Remove master keys file",

	// ── Skip-master-keys warning: escalating 4-stage confirmation shown when the
	// user tries to reset without uploading a master keys file ─────────────────
	/** Skip-master-keys warning, stage 1 of 4 — title shown when the user tries to continue without uploading a master keys file */
	skipMasterKeysWarningStage1Title: "Continue without your master keys file?",
	/** Skip-master-keys warning, stage 1 of 4 — body stating the immediate consequence */
	skipMasterKeysWarningStage1Body:
		"Without your master keys file, resetting your password permanently deletes access to all of your existing files, notes and chats. This cannot be undone.",
	/** Skip-master-keys warning, stage 1 of 4 — confirm button continuing past the warning */
	skipMasterKeysWarningStage1Continue: "Continue",
	/** Skip-master-keys warning, stage 2 of 4 — title escalating the confirmation */
	skipMasterKeysWarningStage2Title: "Are you sure?",
	/** Skip-master-keys warning, stage 2 of 4 — body spelling out that EVERY existing file, note and chat is affected, not just some of them */
	skipMasterKeysWarningStage2Body:
		"Every file, note and chat currently in your account will become permanently unrecoverable — not just some of them. Data you add after the reset is unaffected.",
	/** Skip-master-keys warning, stage 2 of 4 — confirm button continuing past the warning */
	skipMasterKeysWarningStage2Continue: "Yes, I'm sure",
	/** Skip-master-keys warning, stage 3 of 4 — title stressing the decision is final */
	skipMasterKeysWarningStage3Title: "There is no way to undo this",
	/** Skip-master-keys warning, stage 3 of 4 — body stating Filen cannot recover the data afterwards, through support or otherwise */
	skipMasterKeysWarningStage3Body:
		"Filen cannot recover this data for you afterwards, through support or otherwise. Only continue if you accept losing it permanently.",
	/** Skip-master-keys warning, stage 3 of 4 — confirm button continuing past the warning */
	skipMasterKeysWarningStage3Continue: "I understand",
	/** Skip-master-keys warning, stage 4 of 4 — title for the final typed-confirmation gate */
	skipMasterKeysWarningStage4Title: "Type to confirm",
	/** Skip-master-keys warning, stage 4 of 4 — body instructing the user to type the confirmation phrase to arm the confirm button; {{phrase}} interpolates skipMasterKeysWarningTypedConfirmPhrase */
	skipMasterKeysWarningStage4Body:
		'Type "{{phrase}}" below to confirm you accept permanently losing your existing files, notes and chats. This is your last chance to cancel.',
	/** Skip-master-keys warning, stage 4 of 4 — label for the confirmation-phrase input */
	skipMasterKeysWarningTypedConfirmLabel: "Confirmation phrase",
	/** Skip-master-keys warning, stage 4 of 4 — the phrase the user must type EXACTLY (character for character, including case) to confirm permanently losing their data; translate as a short, natural phrase a user can type in your language — it is compared verbatim against what they type */
	skipMasterKeysWarningTypedConfirmPhrase: "DELETE ALL MY DATA",
	/** Skip-master-keys warning, stage 4 of 4 — confirm button that runs the actual reset once the typed phrase arms it */
	skipMasterKeysWarningStage4Confirm: "Reset password and delete my data",

	// ── Logout confirm ───────────────────────────────────────────────────────────
	/** Logout confirm dialog — title; the confirm button reuses common:signOut */
	logoutConfirmTitle: "Sign out?",
	/** Logout confirm dialog — body warning that locally cached data is wiped, distinct from the account data itself which stays intact */
	logoutConfirmBody:
		"Signing out clears any files, notes and chats cached on this device. Your account and its contents stay safe on Filen's servers and sync back the next time you sign in.",

	// ── Security settings page ──────────────────────────────────────────────────
	/** Security settings — page title */
	securityTitle: "Security",
	/** Security settings — error-state title shown when the account query (getUserInfo) fails to load; paired with common:tryAgain */
	securityLoadError: "Couldn't load your account",

	// ── Change password (security settings) ─────────────────────────────────────
	/** Change-password section — heading and dialog title */
	changePasswordTitle: "Change password",
	/** Change-password section — subtitle describing the action */
	changePasswordDescription: "Update your account password",
	/** Change-password form — current-password field label */
	changePasswordCurrent: "Current password",
	/** Change-password form — new-password field label */
	changePasswordNew: "New password",
	/** Change-password form — confirm-new-password field label */
	changePasswordConfirm: "Confirm new password",
	/** Change-password form — submit button */
	changePasswordSubmit: "Update password",
	/** Change-password form — success message after the password is changed */
	changePasswordSuccess: "Your password has been updated.",
	/** Change-password form — warning toast when the password was changed but the new session could not be saved on this device; the previously-saved session is cleared, so the next sign-in on this device needs the new password */
	changePasswordPersistFailed: "Your password was changed, but the new session could not be saved on this device. Please sign in again.",

	// ── Two-factor authentication (security settings) ───────────────────────────
	/** Two-factor authentication section — heading */
	twoFactorSectionTitle: "Two-factor authentication",
	/** Two-factor authentication section — subtitle describing the feature */
	twoFactorSectionDescription: "Require a code from your authenticator app when signing in",
	/** Two-factor code-entry step title, shared by the enable, disable, and delete-account confirmation flows — the instruction is identical regardless of which action the code confirms */
	twoFactorEnterCodeTitle: "Enter two-factor code",
	/** Two-factor code-entry step body, shared by the enable, disable, and delete-account confirmation flows */
	twoFactorEnterCodeBody: "Open your authenticator app and enter the six-digit code",
	/** Enable-two-factor flow — button revealing the QR/secret step, and the code-entry dialog's submit button that confirms setup and enables two-factor authentication */
	twoFactorEnableSubmit: "Enable",
	/** Enable-two-factor flow — button that copies the raw secret (the QR's underlying value) to the clipboard, for authenticator apps that accept manual entry instead of scanning */
	twoFactorCopySecret: "Copy secret",
	/** Disable-two-factor dialog — title */
	twoFactorDisableTitle: "Disable two-factor authentication",
	/** Disable-two-factor dialog — body warning about the security trade-off */
	twoFactorDisableBody: "Are you sure you want to disable two-factor authentication? Your account will be less secure.",
	/** Disable-two-factor dialog — submit button; also the disable flow's code-entry dialog submit button */
	twoFactorDisableSubmit: "Disable",

	// ── Recovery key (two-factor backup code), shown once right after enabling ─
	/** Recovery-key screen — title shown once, right after enabling two-factor authentication */
	recoveryKeyTitle: "Save your recovery key",
	/** Recovery-key screen — body stressing this is the only time the key is shown and Filen cannot recover it afterwards */
	recoveryKeyBody:
		"This is the only time your recovery key will be shown. Copy it and store it somewhere safe — you'll need it if you ever lose access to your authenticator app, and it cannot be retrieved again.",
	/** Recovery-key screen — confirm button the user must press to acknowledge they saved the key before it closes */
	recoveryKeySavedConfirm: "I've saved my recovery key",
	/** Recovery-key screen — button that copies the key to the clipboard */
	recoveryKeyCopy: "Copy",
	/** Recovery-key screen — button that downloads the key as a .txt file */
	recoveryKeyDownload: "Download",
	/** Shared confirmation toast after any copy-to-clipboard action in security settings (the 2FA secret, the recovery key) */
	copiedToClipboard: "Copied to clipboard",

	// ── Export master keys (security settings) + reminder nag ──────────────────
	/** Export-master-keys row, dialog title, and button label */
	exportMasterKeysAction: "Export master keys",
	/** Export-master-keys row — subtitle summarizing the purpose */
	exportMasterKeysDescription: "Back up your master keys to restore access if you forget your password",
	/** Export-master-keys dialog — body explaining why master keys matter for password reset */
	exportMasterKeysBody:
		"Your master keys are required to recover your account if you forget your password. Export and store them somewhere safe.",
	/** Export-master-keys card — accessible label for the destructive badge shown when master keys have never been exported */
	exportMasterKeysNotBackedUp: "Not backed up",
	/** Master-keys reminder banner — title shown when the user has never exported their master keys */
	exportMasterKeysReminderTitle: "Back up your master keys",
	/** Master-keys reminder banner — body explaining the risk of never exporting them */
	exportMasterKeysReminderBody:
		"Your master keys are the only way to recover your data if you forget your password. Export and store them somewhere safe.",
	/** Master-keys reminder banner — action button that opens the export flow */
	exportMasterKeysReminderAction: "Export now",
	/** Master-keys reminder banner — dismiss action that postpones the reminder */
	exportMasterKeysReminderDismiss: "Remind me later",

	// ── Delete account: two-stage confirm, then "check your email" ─────────────
	/** Delete-account section — heading and first confirmation dialog title */
	deleteAccountTitle: "Delete account",
	/** Delete-account card — short subtitle under the heading (the dialogs carry the full irreversibility warning) */
	deleteAccountDescription: "Permanently delete your account and all of its data",
	/** Delete-account dialog, stage 1 — body stating the action is irreversible and starts with a confirmation email */
	deleteAccountBody:
		"This will permanently delete your account and cannot be undone. We will first send a confirmation email before anything is deleted.",
	/** Delete-account dialog, stage 2 — title for the final "are you sure" confirmation */
	deleteAccountConfirmTitle: "Are you sure?",
	/** Delete-account dialog, stage 2 — body for the final confirmation */
	deleteAccountConfirmBody: "Are you sure you want to request deletion of your account?",
	/** Delete-account dialog — prompt shown above the two-factor code field when the account has two-factor authentication enabled */
	deleteAccountTwoFactorPrompt: "Enter your two-factor authentication code to confirm",
	/** Delete-account dialog — submit button */
	deleteAccountSubmit: "Request deletion",
	/** Delete-account — confirmation shown after the request is submitted; actual deletion is confirmed via a homepage-owned email link, not a web-app route */
	deleteAccountConfirmationSent: "Account deletion requested. Please follow the instructions we sent to your email."
} as const
