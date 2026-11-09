// "settings" namespace — Billing — plans, purchase, cancel, withdrawal, invoices. Spread into settings.ts; same catalog rules (flat, camelCase, keys unique
// across the namespace's files, no literal '.' or ':').
export const settingsBilling = {
	// ── Plans ──
	/** Settings sidebar — Plans section nav label and that page's heading (web app only) */
	settingsSectionPlans: "Plans",
	/** Billing page — button on the current-plan row opening the Plans page */
	settingsBillingSeePlans: "See plans",
	/** Plans view — tab listing monthly plans */
	settingsBillingTabMonthly: "Monthly",
	/** Plans view — tab listing annual plans */
	settingsBillingTabAnnually: "Annually",
	/** Plans view — tab listing the small Starter plans */
	settingsBillingTabStarter: "Starter",
	/** Plans view — tab listing one-time (lifetime) plans */
	settingsBillingTabLifetime: "Lifetime",
	/** Plan card — the plan's name followed by its billing term, e.g. "Pro I (Monthly)"; {{name}} is the plan name, {{term}} one of the term words below */
	settingsBillingPlanNameWithTerm: "{{name}} ({{term}})",
	/** Plan card — billing term word inside the plan title: billed every month */
	settingsBillingTermMonthly: "Monthly",
	/** Plan card — billing term word inside the plan title: billed every year */
	settingsBillingTermAnnually: "Annually",
	/** Plan card — billing term word inside the plan title: paid once, never renews */
	settingsBillingTermLifetime: "Lifetime",
	/** Plan card — line under the price of a monthly plan */
	settingsBillingPricePerMonth: "per month",
	/** Plan card — line under the price of an annual plan */
	settingsBillingPricePerYear: "per year",
	/** Plan card — line under the price of a lifetime plan, paid once */
	settingsBillingPriceOnce: "one-time payment",
	/** Plan card — screen-reader text for the struck-through regular price during a sale; {{price}} is the formatted amount */
	settingsBillingRegularPrice: "Regular price {{price}}",
	/** Plan card — sale badge with the discount; {{percent}} is a whole number */
	settingsBillingDiscount: "−{{percent}}%",
	/** Plan card — badge on lifetime plans and plans on sale */
	settingsBillingLimited: "Limited availability",
	/** Plan card — badge on the plan most people choose */
	settingsBillingPopular: "Popular",
	/** Plan card — badge on a plan the account already holds a live subscription for */
	settingsBillingCurrentPlanBadge: "Current plan",
	/** Plan card — storage included in the plan; {{storage}} is a formatted size like "2 TB" */
	settingsBillingPlanStorage: "{{storage}} storage",
	/** Plan card — feature line */
	settingsBillingFeatureBandwidth: "Unlimited bandwidth",
	/** Plan card — feature line */
	settingsBillingFeatureUploads: "Unlimited uploads",
	/** Plan card — feature line */
	settingsBillingFeatureEncryption: "Client side encryption",
	/** Plan card — feature line */
	settingsBillingFeatureZeroKnowledge: "Zero knowledge technology",
	/** Plan card — feature line */
	settingsBillingFeatureSyncing: "Syncing",
	/** Plan card — feature line */
	settingsBillingFeatureNetworkDrive: "Network drive",
	/** Plan card — feature line */
	settingsBillingFeatureSharing: "File sharing",
	/** Plan card — feature line */
	settingsBillingFeatureNotes: "Unlimited notes",
	/** Plan card — feature line */
	settingsBillingFeatureChats: "Unlimited chats",
	/** Plan card — button opening the payment method menu */
	settingsBillingBuy: "Buy",
	/** Plan card — payment method menu item */
	settingsBillingMethodCard: "Credit card",
	/** Plan card — payment method menu item (brand name) */
	settingsBillingMethodPaypal: "PayPal",
	/** Plan card — payment method menu item, offered for lifetime plans only */
	settingsBillingMethodCrypto: "Cryptocurrencies",
	/** Plan card — link opening the payment page in a new tab once the checkout was created */
	settingsBillingPayInvoice: "Pay invoice",
	/** Plan card — tooltip on the disabled Buy button in development builds, whose test prices do not match the live plans */
	settingsBillingBuyDevDisabled: "Purchases are disabled in development builds.",
	/** Plan card — tooltip on the disabled Buy button while current prices are still loading */
	settingsBillingBuyLoadingPrices: "Loading current prices…",
	/** Plans view — notice in the personal information dialog when buying needs a country first */
	settingsBillingCountryRequired: "Please select a country so we can calculate the correct VAT.",
	/** Plans view — legal footer for recurring plans: renewals, cancellation and refunds */
	settingsBillingLegalRenewal:
		"By purchasing a plan you authorize Filen to automatically charge you each billing period until you cancel. You can cancel anytime via your Account page. No partial refunds.",
	/** Plans view — legal footer for one-time (lifetime) purchases, which never renew; shown instead of, or with, the renewal text */
	settingsBillingLegalOneTime: "This is a one-time purchase. No partial refunds.",
	/** Plans view — legal footer; keep the <terms> and <privacy> tags around the link texts */
	settingsBillingLegalAgreement: "You also agree to our <terms>Terms of Service</terms> and <privacy>Privacy Policy</privacy>.",
	/** Plans view — message when the plans could not be loaded; paired with a retry button */
	settingsBillingPlansLoadError: "Plans could not be loaded.",
	/** Plans view — empty state when no plan is on offer */
	settingsBillingPlansEmpty: "No plans are available right now.",
	/** Billing and Account storage — footnote shown to accounts on the free tier */
	settingsBillingFreeTierNote:
		"Our free tier and free storage work best on standard residential internet connections. Registration via VPNs, Tor, proxies, relays, or hosting networks may be excluded from free storage.",
	/** Desktop app Billing page — link opening billing in the browser */
	settingsBillingManageOnWeb: "Manage plan and billing on the web",

	// ── Subscriptions ──
	/** Subscriptions and invoices tables — header of the column holding row actions */
	settingsBillingColumnActions: "Actions",
	/** Subscriptions table — button cancelling a recurring subscription */
	settingsBillingCancelAction: "Cancel subscription",
	/** Subscriptions table — note on the disabled cancel button within a day of the purchase; {{date}} is a date and time */
	settingsBillingCancelAvailableFrom: "Can be cancelled from {{date}}",
	/** Cancel subscription dialog — title */
	settingsBillingCancelConfirmTitle: "Cancel subscription?",
	/** Cancel subscription dialog — body; {{plan}} is the plan name */
	settingsBillingCancelConfirmBody: "{{plan}} stays active until the end of the current billing period and is not renewed.",
	/** Cancel subscription dialog — confirm button */
	settingsBillingCancelConfirm: "Cancel subscription",
	/** Cancel subscription dialog — dismiss button */
	settingsBillingCancelKeep: "Keep subscription",
	/** Toast after cancelling a subscription */
	settingsBillingCancelSuccess: "Subscription cancelled. It stays active until the end of the current billing period.",
	/** Subscriptions table — link to the card payment provider's portal for payment details and receipts */
	settingsBillingDetails: "Billing details",
	/** Subscriptions table — status line once a withdrawal was received; {{date}} is a date and time */
	settingsBillingWithdrawalReceived: "Withdrawal received on {{date}}",

	// ── Withdrawal (button labels follow the statutory wording: keep them unambiguous) ──
	/** Withdrawal entry points (account menu, subscriptions table) and dialog title */
	settingsBillingWithdraw: "Withdraw from contract",
	/** Withdrawal entry points — how long it is possible; {{date}} is the last day */
	settingsBillingWithdrawUntil: "until {{date}}",
	/** Account button — screen-reader status while a withdrawal is possible; {{date}} is the last day */
	settingsBillingWithdrawStatus: "contract withdrawal possible until {{date}}",
	/** Withdrawal dialog — description */
	settingsBillingWithdrawDescription: "You can withdraw within 14 days without giving a reason.",
	/** Withdrawal dialog — name field label */
	settingsBillingWithdrawName: "Name",
	/** Withdrawal dialog — contract field label */
	settingsBillingWithdrawContract: "Contract",
	/** Withdrawal dialog — a contract in the chooser; {{plan}} is the plan name, {{cost}} its formatted price */
	settingsBillingWithdrawContractLabel: "{{plan}} · {{cost}}",
	/** Withdrawal dialog — line under the contract; {{date}} is the start date, {{id}} a short contract number */
	settingsBillingWithdrawContractDetail: "{{date}} · #{{id}}",
	/** Withdrawal dialog — email field label: where the confirmation of receipt is sent */
	settingsBillingWithdrawEmail: "Email for the receipt",
	/** Withdrawal dialog — submit button (statutory wording) */
	settingsBillingWithdrawConfirm: "Confirm withdrawal",
	/** Withdrawal dialog — inline error under an empty name */
	settingsBillingWithdrawNameRequired: "Please enter your name.",
	/** Withdrawal dialog — inline error under an invalid email address */
	settingsBillingWithdrawEmailInvalid: "Please enter a valid email address.",
	/** Withdrawal dialog — message when no contract can be withdrawn from any more */
	settingsBillingWithdrawNoneEligible: "No contract can be withdrawn from right now.",
	/** Toast after a withdrawal was sent: received, never approved */
	settingsBillingWithdrawSuccess: "Your withdrawal has been received. A confirmation will follow by email.",
	/** Toast when the withdrawal was recorded but the server reported an error, so the confirmation email may be missing */
	settingsBillingWithdrawReceiptMissing:
		"Your withdrawal has been received, but the confirmation email may not have been sent. If it does not arrive, please contact support.",

	// ── Invoices ──
	/** Invoices table — header of the download column */
	settingsBillingColumnDownload: "Download",
	/** Invoices table — download button; {{date}} is the invoice date, read by screen readers */
	settingsBillingInvoiceDownload: "Download invoice from {{date}}",

	// ── Errors (server codes) ──
	/** Error toast — the subscription cannot be cancelled now (within a day of purchase, or not a recurring one) */
	settingsBillingErrorCannotCancel:
		"This subscription can't be cancelled right now. Subscriptions can be cancelled 24 hours after purchase.",
	/** Error toast — the withdrawal period has ended */
	settingsBillingErrorCannotWithdraw: "The withdrawal period for this contract has ended.",
	/** Error toast — the subscription is not on this account (any more) */
	settingsBillingErrorSubNotFound: "This subscription could not be found. Reload the page and try again.",
	/** Error toast — the invoice is not on this account (any more) */
	settingsBillingErrorInvoiceNotFound: "This invoice could not be found.",
	/** Error toast — the plan is no longer sold */
	settingsBillingErrorPlanUnavailable: "This plan is no longer available. Reload the page and try again.",
	/** Error toast — the payment method is not offered for this plan */
	settingsBillingErrorMethodUnavailable: "This payment method isn't available for this plan.",
	/** Error toast — too many checkout attempts */
	settingsBillingErrorRateLimited: "Too many attempts. Please wait a while and try again.",
	/** Error toast — the server rejected the entered details */
	settingsBillingErrorInvalidParams: "Please check your entries and try again.",

	// ── Appear offline ──
	/** Account page, Preferences — toggle title */
	settingsAppearOfflineTitle: "Appear offline",
	/** Account page, Preferences — toggle description */
	settingsAppearOfflineDescription: "Your contacts and chat partners see you as offline."
} as const
