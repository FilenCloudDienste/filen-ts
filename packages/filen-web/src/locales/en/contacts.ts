// English source catalog — "contacts" namespace: the contacts page (established contacts, blocked
// contacts, incoming/outgoing requests), the add-contact dialog, and every per-row/bulk action and
// confirm dialog contacts exposes. Same typed-catalog rules as common/errors/auth/drive: flat
// `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces,
// keySeparator/nsSeparator both ON). `moduleContacts` (the icon-rail label) stays in "common" — not
// duplicated here.
//
// Every key below is declared ahead of the components that will render it, so no literal string
// lands in a contacts component later (the drive.ts convention). Wording mirrors filen-mobile's
// contacts feature (useContacts.query.ts consumers, contactsActions.ts, contactRow.tsx,
// contactsHeader.tsx) where an equivalent surface already exists there.
export const contacts = {
	// ── Section headers ──────────────────────────────────────────────────────
	/** Contacts sidebar/page — nav entry and implicit section label for the unfiltered, every-section view */
	contactsSectionAll: "All",
	/** Contacts sidebar/page — section header for incoming contact requests */
	contactsSectionRequests: "Requests",
	/** Contacts sidebar/page — section header for outgoing (sent, not yet accepted) contact requests */
	contactsSectionPending: "Pending",
	/** Contacts sidebar/page — section header for established contacts */
	contactsSectionContacts: "Contacts",
	/** Contacts sidebar/page — section header for blocked contacts */
	contactsSectionBlocked: "Blocked",

	// ── Empty states ─────────────────────────────────────────────────────────
	/** Contacts page — empty-state title when the user has no contacts yet */
	contactsEmptyTitle: "No contacts",
	/** Contacts page — empty-state body under contactsEmptyTitle */
	contactsEmptyBody: "Add a contact to start sharing and chatting.",
	/** Contacts page — empty-state title when a sidebar section filter narrows the list to zero rows, but other sections still have data */
	contactsEmptySectionTitle: "Nothing here",
	/** Contacts page — empty-state body under contactsEmptySectionTitle */
	contactsEmptySectionBody: "No entries in this section.",
	/** Contacts page and every contact-picker dialog — empty-state title when a search/filter query matches nothing, distinct from contactsEmptyTitle's "no contacts at all" onboarding copy */
	contactsSearchNoResultsTitle: "No matches",
	/** Contacts page — empty-state body under contactsSearchNoResultsTitle */
	contactsSearchNoResultsBody: "No contacts match your search.",
	/** Contacts page — title shown when the contacts/requests queries fail to load; the body is the failing query's own errorLabel */
	contactsLoadError: "Couldn't load contacts",

	// ── Search ───────────────────────────────────────────────────────────────
	/** Contacts page — search input placeholder */
	contactsSearchPlaceholder: "Search contacts",

	// ── Bulk selection ───────────────────────────────────────────────────────
	// Rows are permanently selectable (plain click replaces, Ctrl/Cmd toggles, Shift extends a range)
	// and a floating bar appears at 2+ selected, overlaying the list without replacing the search box —
	// the same model drive/notes/chats/photos use. Its per-section action buttons reuse the Row action
	// labels below verbatim.

	// ── Section groups ───────────────────────────────────────────────────────
	/** Contacts page — header of the highlighted incoming-requests panel atop the "All" view, singular */
	contactsRequestsCalloutTitle_one: "{{count}} contact request",
	/** Contacts page — header of the highlighted incoming-requests panel atop the "All" view, plural */
	contactsRequestsCalloutTitle_other: "{{count}} contact requests",
	/** Contacts page — group heading in the "All" view; {{section}} = the section's own header label (contactsSectionPending/Contacts/Blocked), {{count}} = rows in it */
	contactsSectionHeading: "{{section}} · {{count}}",

	// ── Add-contact dialog ───────────────────────────────────────────────────
	// contactsActionAdd doubles as the triggering action label (header/menu button) AND the
	// add-contact dialog's title AND its submit button — same triple reuse as driveActionRename in
	// locales/en/drive.ts.
	/** Add-contact action label; also the add-contact dialog's title and submit button */
	contactsActionAdd: "Add contact",
	/** Add-contact dialog — body prompting for the other person's Filen email address */
	contactsAddBody: "Enter the Filen email address of the person you want to add.",
	/** Add-contact dialog — email field label */
	contactsAddEmailLabel: "Email",
	/** Add-contact dialog — email field placeholder */
	contactsAddEmailPlaceholder: "you@example.com",

	// ── Row menu ─────────────────────────────────────────────────────────────
	/** Contact row — accessible label on the trailing "More actions" (⋯) menu trigger (Remove/Block) */
	contactsRowMenuTrigger: "More actions",

	// ── Row / bulk action labels ─────────────────────────────────────────────
	// Imperative verbs, not state descriptions — same rule as drive.ts's item-menu entries. Each
	// confirm dialog below reuses the matching one of these as its own confirm button. Only Remove
	// and Block render as destructive (contactsRemoveConfirmTitle/contactsBlockConfirmTitle below);
	// Deny/Cancel/Unblock do not, despite filen-mobile flagging deny/cancel destructive too — Unblock
	// lifts a restriction (never destructive on either platform).
	/** Row menu action — creates or opens a 1:1 chat with the contact and navigates into it; no confirm dialog */
	contactsActionMessage: "Message",
	/** Row/bulk action — accept an incoming contact request; no confirm dialog (mirrors mobile) */
	contactsActionAccept: "Accept",
	/** Row/bulk action — deny an incoming contact request; also the deny-confirm dialog's confirm button */
	contactsActionDeny: "Deny",
	/** Row/bulk action — cancel an outgoing (sent) contact request; also the cancel-confirm dialog's confirm button */
	contactsActionCancelRequest: "Cancel request",
	/** Row/bulk action — remove an established contact; also the remove-confirm dialog's confirm button; destructive */
	contactsActionRemove: "Remove",
	/** Row/bulk action — block a contact; also the block-confirm dialog's confirm button; destructive */
	contactsActionBlock: "Block",
	/** Row/bulk action — unblock a blocked contact; also the unblock-confirm dialog's confirm button */
	contactsActionUnblock: "Unblock",

	// ── Deny-request confirm ─────────────────────────────────────────────────
	/** Deny-request confirm dialog — title; the confirm button reuses contactsActionDeny */
	contactsDenyConfirmTitle: "Deny request?",
	/** Deny-request confirm dialog — body for a single request */
	contactsDenyConfirmBody_one: "Are you sure you want to deny this contact request?",
	/** Deny-request confirm dialog — body for multiple requests; {{count}} = requests being denied */
	contactsDenyConfirmBody_other: "Are you sure you want to deny these {{count}} contact requests?",

	// ── Cancel-request confirm ───────────────────────────────────────────────
	/** Cancel-request confirm dialog — title; the confirm button reuses contactsActionCancelRequest */
	contactsCancelConfirmTitle: "Cancel request?",
	/** Cancel-request confirm dialog — body for a single request */
	contactsCancelConfirmBody_one: "Are you sure you want to cancel this contact request?",
	/** Cancel-request confirm dialog — body for multiple requests; {{count}} = requests being cancelled */
	contactsCancelConfirmBody_other: "Are you sure you want to cancel these {{count}} contact requests?",

	// ── Remove-contact confirm (destructive) ─────────────────────────────────
	/** Remove-contact confirm dialog — title; the confirm button reuses contactsActionRemove */
	contactsRemoveConfirmTitle: "Remove contact?",
	/** Remove-contact confirm dialog — body for a single contact */
	contactsRemoveConfirmBody_one: "Are you sure you want to remove this contact?",
	/** Remove-contact confirm dialog — body for multiple contacts; {{count}} = contacts being removed */
	contactsRemoveConfirmBody_other: "Are you sure you want to remove these {{count}} contacts?",

	// ── Block-contact confirm (destructive) ──────────────────────────────────
	/** Block-contact confirm dialog — title; the confirm button reuses contactsActionBlock */
	contactsBlockConfirmTitle: "Block contact?",
	/** Block-contact confirm dialog — body for a single contact */
	contactsBlockConfirmBody_one: "Are you sure you want to block this contact?",
	/** Block-contact confirm dialog — body for multiple contacts; {{count}} = contacts being blocked */
	contactsBlockConfirmBody_other: "Are you sure you want to block these {{count}} contacts?",

	// ── Unblock-contact confirm ───────────────────────────────────────────────
	/** Unblock-contact confirm dialog — title; the confirm button reuses contactsActionUnblock */
	contactsUnblockConfirmTitle: "Unblock contact?",
	/** Unblock-contact confirm dialog — body for a single contact */
	contactsUnblockConfirmBody_one: "Are you sure you want to unblock this contact?",
	/** Unblock-contact confirm dialog — body for multiple contacts; {{count}} = contacts being unblocked */
	contactsUnblockConfirmBody_other: "Are you sure you want to unblock these {{count}} contacts?",

	// ── Activity toasts (lib/activity) ──────────────────────────────────────
	// The running line of an action and how it ended, in the toast that shows it. `_one` names the one
	// contact or request (nickname, else email), `_other` counts them; a partial result counts the ones
	// that succeeded.
	/** Activity toast — accepting contact requests running; one item named ({{name}}) */
	contactsAcceptRunning_one: "Accepting the request from {{name}}",
	/** Activity toast — accepting contact requests running; {{count}} items */
	contactsAcceptRunning_other: "Accepting {{count}} requests",
	/** Activity toast — accepting contact requests finished; one item named ({{name}}) */
	contactsAcceptDone_one: "Accepted the request from {{name}}",
	/** Activity toast — accepting contact requests finished; {{count}} items */
	contactsAcceptDone_other: "Accepted {{count}} requests",
	/** Activity toast — accepting contact requests failed for every item; one item named ({{name}}) */
	contactsAcceptFailed_one: "Couldn't accept the request from {{name}}",
	/** Activity toast — accepting contact requests failed for every item; {{count}} items */
	contactsAcceptFailed_other: "Couldn't accept {{count}} requests",
	/** Activity toast — accepting contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsAcceptPartial_one: "Accepted {{count}} request, {{failed}} failed",
	/** Activity toast — accepting contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsAcceptPartial_other: "Accepted {{count}} requests, {{failed}} failed",
	/** Activity toast — denying contact requests running; one item named ({{name}}) */
	contactsDenyRunning_one: "Denying the request from {{name}}",
	/** Activity toast — denying contact requests running; {{count}} items */
	contactsDenyRunning_other: "Denying {{count}} requests",
	/** Activity toast — denying contact requests finished; one item named ({{name}}) */
	contactsDenyDone_one: "Denied the request from {{name}}",
	/** Activity toast — denying contact requests finished; {{count}} items */
	contactsDenyDone_other: "Denied {{count}} requests",
	/** Activity toast — denying contact requests failed for every item; one item named ({{name}}) */
	contactsDenyFailed_one: "Couldn't deny the request from {{name}}",
	/** Activity toast — denying contact requests failed for every item; {{count}} items */
	contactsDenyFailed_other: "Couldn't deny {{count}} requests",
	/** Activity toast — denying contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsDenyPartial_one: "Denied {{count}} request, {{failed}} failed",
	/** Activity toast — denying contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsDenyPartial_other: "Denied {{count}} requests, {{failed}} failed",
	/** Activity toast — cancelling sent contact requests running; one item named ({{name}}) */
	contactsCancelRequestRunning_one: "Cancelling the request to {{name}}",
	/** Activity toast — cancelling sent contact requests running; {{count}} items */
	contactsCancelRequestRunning_other: "Cancelling {{count}} requests",
	/** Activity toast — cancelling sent contact requests finished; one item named ({{name}}) */
	contactsCancelRequestDone_one: "Cancelled the request to {{name}}",
	/** Activity toast — cancelling sent contact requests finished; {{count}} items */
	contactsCancelRequestDone_other: "Cancelled {{count}} requests",
	/** Activity toast — cancelling sent contact requests failed for every item; one item named ({{name}}) */
	contactsCancelRequestFailed_one: "Couldn't cancel the request to {{name}}",
	/** Activity toast — cancelling sent contact requests failed for every item; {{count}} items */
	contactsCancelRequestFailed_other: "Couldn't cancel {{count}} requests",
	/** Activity toast — cancelling sent contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsCancelRequestPartial_one: "Cancelled {{count}} request, {{failed}} failed",
	/** Activity toast — cancelling sent contact requests partly failed; {{count}} succeeded, {{failed}} failed */
	contactsCancelRequestPartial_other: "Cancelled {{count}} requests, {{failed}} failed",
	/** Activity toast — removing contacts running; one item named ({{name}}) */
	contactsRemoveRunning_one: "Removing {{name}}",
	/** Activity toast — removing contacts running; {{count}} items */
	contactsRemoveRunning_other: "Removing {{count}} contacts",
	/** Activity toast — removing contacts finished; one item named ({{name}}) */
	contactsRemoveDone_one: "Removed {{name}}",
	/** Activity toast — removing contacts finished; {{count}} items */
	contactsRemoveDone_other: "Removed {{count}} contacts",
	/** Activity toast — removing contacts failed for every item; one item named ({{name}}) */
	contactsRemoveFailed_one: "Couldn't remove {{name}}",
	/** Activity toast — removing contacts failed for every item; {{count}} items */
	contactsRemoveFailed_other: "Couldn't remove {{count}} contacts",
	/** Activity toast — removing contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsRemovePartial_one: "Removed {{count}} contact, {{failed}} failed",
	/** Activity toast — removing contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsRemovePartial_other: "Removed {{count}} contacts, {{failed}} failed",
	/** Activity toast — blocking contacts running; one item named ({{name}}) */
	contactsBlockRunning_one: "Blocking {{name}}",
	/** Activity toast — blocking contacts running; {{count}} items */
	contactsBlockRunning_other: "Blocking {{count}} contacts",
	/** Activity toast — blocking contacts finished; one item named ({{name}}) */
	contactsBlockDone_one: "Blocked {{name}}",
	/** Activity toast — blocking contacts finished; {{count}} items */
	contactsBlockDone_other: "Blocked {{count}} contacts",
	/** Activity toast — blocking contacts failed for every item; one item named ({{name}}) */
	contactsBlockFailed_one: "Couldn't block {{name}}",
	/** Activity toast — blocking contacts failed for every item; {{count}} items */
	contactsBlockFailed_other: "Couldn't block {{count}} contacts",
	/** Activity toast — blocking contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsBlockPartial_one: "Blocked {{count}} contact, {{failed}} failed",
	/** Activity toast — blocking contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsBlockPartial_other: "Blocked {{count}} contacts, {{failed}} failed",
	/** Activity toast — unblocking contacts running; one item named ({{name}}) */
	contactsUnblockRunning_one: "Unblocking {{name}}",
	/** Activity toast — unblocking contacts running; {{count}} items */
	contactsUnblockRunning_other: "Unblocking {{count}} contacts",
	/** Activity toast — unblocking contacts finished; one item named ({{name}}) */
	contactsUnblockDone_one: "Unblocked {{name}}",
	/** Activity toast — unblocking contacts finished; {{count}} items */
	contactsUnblockDone_other: "Unblocked {{count}} contacts",
	/** Activity toast — unblocking contacts failed for every item; one item named ({{name}}) */
	contactsUnblockFailed_one: "Couldn't unblock {{name}}",
	/** Activity toast — unblocking contacts failed for every item; {{count}} items */
	contactsUnblockFailed_other: "Couldn't unblock {{count}} contacts",
	/** Activity toast — unblocking contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsUnblockPartial_one: "Unblocked {{count}} contact, {{failed}} failed",
	/** Activity toast — unblocking contacts partly failed; {{count}} succeeded, {{failed}} failed */
	contactsUnblockPartial_other: "Unblocked {{count}} contacts, {{failed}} failed"
} as const
