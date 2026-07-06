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
// Split-sentence links (`dontHaveAccount`, `alreadyHaveAccount`) embed the tappable segment as a
// `<link>…</link>` placeholder for react-i18next's `<Trans>` component. Prefer the bound-`t` form
// (`const { t } = useTranslation("auth")` then `<Trans t={t} i18nKey="dontHaveAccount">`) — a
// cross-namespace `i18nKey="auth:key"` string does not infer cleanly under this app's typed
// `CustomTypeOptions`.
//
// The skip-keys stage-4 gate compares the typed value against the account email (interpolated
// into the copy as {{email}}) — a live value, never a translated phrase.
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
	/** Login screen — split-sentence link to the register screen; <link> wraps "Sign up" */
	dontHaveAccount: "Don't have an account? <link>Sign up</link>",

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
	/** Register screen — split-sentence link to the login screen; <link> wraps "Sign in" */
	alreadyHaveAccount: "Already have an account? <link>Sign in</link>",

	// ── Password strength meter (register screen) ───────────────────────────────
	/** Register screen — label for the live password-strength meter */
	passwordStrengthLabel: "Password strength",
	/** Password-strength rating: weakest tier */
	passwordStrengthWeak: "Weak",
	/** Password-strength rating: medium tier */
	passwordStrengthNormal: "Fair",
	/** Password-strength rating: strong tier */
	passwordStrengthStrong: "Strong",
	/** Password-strength rating: strongest tier */
	passwordStrengthBest: "Very strong",

	// ── Free-storage eligibility banner (register screen) ───────────────────────
	/** Register screen — eligibility banner shown when the region/IP IS eligible for the free-storage signup bonus */
	registerCheckEligible: "You are eligible for 10 GiB of free storage!",
	/** Register screen — eligibility banner shown when NOT eligible (or the check could not complete) */
	registerCheckNotEligible: "You are not eligible for 10 GiB of free storage.",
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

	// ── Skip-master-keys warning: escalating 4-stage confirmation shown when the
	// user tries to reset without uploading a master keys file ─────────────────
	/** Skip-master-keys warning, stage 1 of 4 — title shown when the user tries to continue without uploading a master keys file */
	skipMasterKeysWarningStage1Title: "Continue without your master keys file?",
	/** Skip-master-keys warning, stage 1 of 4 — body stating the immediate consequence */
	skipMasterKeysWarningStage1Body:
		"Without your master keys file, resetting your password permanently deletes access to all of your existing files, notes and chats. This cannot be undone.",
	/** Skip-master-keys warning, stage 2 of 4 — title escalating the confirmation */
	skipMasterKeysWarningStage2Title: "Are you sure?",
	/** Skip-master-keys warning, stage 2 of 4 — body spelling out that EVERY existing file, note and chat is affected, not just some of them */
	skipMasterKeysWarningStage2Body:
		"Every file, note and chat currently in your account will become permanently unrecoverable — not just some of them. Data you add after the reset is unaffected.",
	/** Skip-master-keys warning, stage 3 of 4 — title stressing the decision is final */
	skipMasterKeysWarningStage3Title: "There is no way to undo this",
	/** Skip-master-keys warning, stage 3 of 4 — body stating Filen cannot recover the data afterwards, through support or otherwise */
	skipMasterKeysWarningStage3Body:
		"Filen cannot recover this data for you afterwards, through support or otherwise. Only continue if you accept losing it permanently.",
	/** Skip-master-keys warning, stage 4 of 4 — title for the final typed-confirmation gate */
	skipMasterKeysWarningStage4Title: "Type to confirm",
	/** Skip-master-keys warning, stage 4 of 4 — body instructing the user to type their account email to arm the confirm button; {{email}} interpolates the live account email */
	skipMasterKeysWarningStage4Body:
		"Type your email address ({{email}}) below to confirm you accept permanently losing your existing files, notes and chats. This is your last chance to cancel.",
	/** Skip-master-keys warning, stage 4 of 4 — label for the typed-email confirmation input */
	skipMasterKeysWarningTypedConfirmLabel: "Your email address",

	// ── Logout confirm ───────────────────────────────────────────────────────────
	/** Logout confirm dialog — title; the confirm button reuses common:signOut */
	logoutConfirmTitle: "Sign out?",
	/** Logout confirm dialog — body warning that locally cached data is wiped, distinct from the account data itself which stays intact */
	logoutConfirmBody:
		"Signing out clears any files, notes and chats cached on this device. Your account and its contents stay safe on Filen's servers and sync back the next time you sign in.",

	// ── Security settings page ──────────────────────────────────────────────────
	/** Security settings — page title */
	securityTitle: "Security",

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

	// ── Two-factor authentication (security settings) ───────────────────────────
	/** Two-factor authentication section — heading */
	twoFactorSectionTitle: "Two-factor authentication",
	/** Two-factor authentication section — subtitle describing the feature */
	twoFactorSectionDescription: "Require a code from your authenticator app when signing in",
	/** Enable-two-factor flow — title for the code-entry step that confirms setup */
	twoFactorEnterCodeTitle: "Enter two-factor code",
	/** Enable-two-factor flow — body instructing the user to open their authenticator app */
	twoFactorEnterCodeBody: "Open your authenticator app and enter the six-digit code",
	/** Enable-two-factor flow — submit button that confirms setup and enables two-factor authentication */
	twoFactorEnableSubmit: "Enable",
	/** Disable-two-factor dialog — title */
	twoFactorDisableTitle: "Disable two-factor authentication",
	/** Disable-two-factor dialog — body warning about the security trade-off */
	twoFactorDisableBody: "Are you sure you want to disable two-factor authentication? Your account will be less secure.",
	/** Disable-two-factor dialog — submit button */
	twoFactorDisableSubmit: "Disable",

	// ── Recovery key (two-factor backup code), shown once right after enabling ─
	/** Recovery-key screen — title shown once, right after enabling two-factor authentication */
	recoveryKeyTitle: "Save your recovery key",
	/** Recovery-key screen — body stressing this is the only time the key is shown and Filen cannot recover it afterwards */
	recoveryKeyBody:
		"This is the only time your recovery key will be shown. Copy it and store it somewhere safe — you'll need it if you ever lose access to your authenticator app, and it cannot be retrieved again.",
	/** Recovery-key screen — confirm button the user must press to acknowledge they saved the key before it closes */
	recoveryKeySavedConfirm: "I've saved my recovery key",

	// ── Export master keys (security settings) + reminder nag ──────────────────
	/** Export-master-keys row, dialog title, and button label */
	exportMasterKeysAction: "Export master keys",
	/** Export-master-keys row — subtitle summarizing the purpose */
	exportMasterKeysDescription: "Back up your master keys to restore access if you forget your password",
	/** Export-master-keys dialog — body explaining why master keys matter for password reset */
	exportMasterKeysBody:
		"Your master keys are required to recover your account if you forget your password. Export and store them somewhere safe.",
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
