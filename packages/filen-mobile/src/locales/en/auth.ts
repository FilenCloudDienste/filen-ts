// Authentication feature vocabulary (src/routes/auth/login.tsx and src/routes/register/index.tsx).
// Shared keys (cancel, email, password, sign_in, please_enter_valid_email, email_placeholder_hint)
// live in common.ts and must not be redefined here.
//
// Split-sentence link strings (dont_have_an_account, already_have_an_account) embed the styled
// inline link as a `<link>…</link>` placeholder so the whole sentence is one translatable unit and
// word order can change per locale. They are rendered with react-i18next's <Trans> component, which
// maps `<link>` to a styled <Text onPress={…}> element — never split into two separate t() calls.
export const auth = {
	/** Login screen — large greeting headline shown above the login form */
	welcome_back: "Welcome back",
	/** Login screen — subtitle under the greeting, prompting the user to log in */
	sign_in_to_your_account: "Log in to your account",
	/** Login screen — link below the form that starts the password-reset flow */
	forgot_password: "Forgot password?",
	/** Login screen — split sentence inviting sign-up; <link> wraps the tappable "Create one" that opens registration */
	dont_have_an_account: "Don't have an account? <link>Sign up</link>",
	// two_factor_authentication lives in security.ts.
	/** Two-factor prompt — dialog message asking for the 2FA code or a recovery key */
	enter_two_factor_code_or_recovery_key: "Enter your two-factor code or recovery key",
	/** Two-factor prompt — input placeholder for the 2FA code or recovery key field */
	code_or_recovery_key: "Code or recovery key",
	/** Two-factor prompt — dialog message shown after a rejected code, prompting a re-entry */
	incorrect_two_factor_code_try_again: "Incorrect code. Please try again.",
	/** Password-reset prompt — dialog title for requesting a reset email */
	reset_password: "Reset password",
	/** Password-reset prompt — dialog message asking for the account email address */
	enter_account_email: "Enter your account email address",
	/** Password-reset prompt — confirm button that sends the reset email */
	send: "Send",
	/** Toast shown after a password-reset email has been requested successfully */
	password_reset_email_sent: "If an account exists for that address, a password reset email has been sent.",
	/** Registration screen — header title */
	register: "Sign up",
	/** Registration screen — large greeting headline shown above the form */
	create_account_welcome: "Create your account",
	/** Registration screen — subtitle under the greeting describing the sign-up */
	register_subtitle: "Sign up for a free Filen account",
	/** Registration form — placeholder for the confirm-password field */
	confirm_password: "Confirm password",
	/** Registration form — label for the live password-strength indicator */
	password_strength: "Password strength",
	/** Password-strength rating: weakest tier */
	password_strength_weak: "Weak",
	/** Password-strength rating: medium tier */
	password_strength_normal: "Fair",
	/** Password-strength rating: strong tier */
	password_strength_strong: "Strong",
	/** Password-strength rating: strongest tier */
	password_strength_best: "Very strong",
	/** Registration form — helper line shown under the strength meter when the entered password is below the minimum required strength */
	password_too_weak_to_register: "Choose a stronger password to continue",
	// passwords_do_not_match lives in common.ts.
	/** Registration screen — primary submit button that creates the account */
	create_account: "Create account",
	/** Toast shown after an account has been created successfully */
	account_created: "Account created. Please check your email to confirm your address.",
	/** Registration screen — link/dialog title to resend the email-confirmation message */
	resend_confirmation_email: "Resend confirmation email",
	/** Resend-confirmation prompt — dialog message asking for the registered email address */
	enter_registered_email: "Enter the email address you registered with",
	/** Resend-confirmation prompt — confirm button that resends the confirmation email */
	resend: "Resend",
	/** Toast shown after a confirmation email has been resent successfully */
	resend_confirmation_email_sent: "If an account exists for that address, a confirmation email has been sent.",
	/** Registration screen — split sentence offering login; <link> wraps the tappable "Log in" that closes registration */
	already_have_an_account: "Already have an account? <link>Log in</link>",
	/** Registration screen — eligibility card shown when the IP/region IS eligible for the free-storage signup bonus */
	register_free_storage_eligible: "You are eligible for 10 GiB of free storage!",
	/** Registration screen — eligibility card shown when NOT eligible (or the check could not be completed) */
	register_free_storage_not_eligible: "You are not eligible for 10 GiB of free storage.",
	/** Registration screen — link on the eligibility card opening the explainer article */
	register_free_storage_learn_more: "Learn more"
} as const
