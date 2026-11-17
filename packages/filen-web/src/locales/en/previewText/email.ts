// "preview" namespace, text family — an e-mail message. Spread into preview.ts; same catalog rules.
export const previewTextEmail = {
	/** Email preview — the view switch's accessible name (HTML | Text | Source) */
	previewEmailView: "Message view",
	/** Email preview — the view switch: the message's HTML body */
	previewEmailViewHtml: "HTML",
	/** Email preview — the view switch: the message's plain-text body */
	previewEmailViewText: "Text",
	/** Email preview — the view switch: the message as it is stored, read-only */
	previewEmailViewSource: "Source",
	/** Email preview — the title of a message without a subject */
	previewEmailNoSubject: "(No subject)",
	/** Email preview — header label: the sender */
	previewEmailFrom: "From",
	/** Email preview — header label: the recipients */
	previewEmailTo: "To",
	/** Email preview — header label: the copied recipients */
	previewEmailCc: "Cc",
	/** Email preview — the button that shows the rest of a recipient list; {{count}} recipients hidden */
	previewEmailMore_one: "+{{count}} more",
	/** Email preview — the button that shows the rest of a recipient list; {{count}} recipients hidden */
	previewEmailMore_other: "+{{count}} more",
	/** Email preview — the button that folds a recipient list again */
	previewEmailLess: "Show less",
	/** Email preview — recipients past the cap, not read; {{count}} of them */
	previewEmailAddressesOmitted_one: "{{count}} more recipient not shown",
	/** Email preview — recipients past the cap, not read; {{count}} of them */
	previewEmailAddressesOmitted_other: "{{count}} more recipients not shown",
	/** Email preview — notice above the body: pictures, styles and other content from the internet the message asked for and that was not loaded; {{count}} of them */
	previewEmailRemoteBlocked_one: "{{count}} remote resource was not loaded.",
	/** Email preview — notice above the body: pictures, styles and other content from the internet the message asked for and that was not loaded; {{count}} of them */
	previewEmailRemoteBlocked_other: "{{count}} remote resources were not loaded.",
	/** Email preview — a message with no body */
	previewEmailNoBody: "This message has no text.",
	/** Email preview — the attachments heading; {{count}} attachments */
	previewEmailAttachments: "Attachments ({{count}})",
	/** Email preview — an attachment's action: view it here */
	previewEmailOpen: "Open",
	/** Email preview — an attachment's action: save it to the device */
	previewEmailDownload: "Download",
	/** Email preview — an attachment's action: upload it into the user's drive */
	previewEmailSaveToDrive: "Save to drive",
	/** Email preview — the directory picker's title when saving an attachment; {{name}} is its file name */
	previewEmailSaveTitle: "Save “{{name}}” to",
	/** Email preview — the directory picker's confirm button when saving an attachment */
	previewEmailSaveConfirm: "Save here",
	/** Email preview — the back button of an opened attachment */
	previewEmailBack: "Back to the message",
	/** Email preview — the message is past what the preview reads */
	previewEmailTooLarge: "This message is too large to show here.",
	/** Email preview — above a text body cut at the text viewers' size limit */
	previewEmailTextTruncated: "This text is longer than can be shown here; only its start is shown.",
	/** Email preview — the label of a muted row under the sender: the account that sent the message on the sender's behalf (Sender header, or Outlook's "on behalf of") */
	previewEmailSentBy: "Sent by",
	/** Email preview — the Reply-To row's label, shown when it names someone other than the sender */
	previewEmailReplyTo: "Reply to",
	/** Email preview — under the sender's address (shown with its domain in ASCII) when the domain has non-ASCII characters; the domain as written follows */
	previewEmailIdnDomain: "Domain written as:",
	/** Email preview — under the headers when parts of a damaged message (a body, an attachment) could not be read */
	previewEmailPartsSkipped_one: "{{count}} part of this message could not be read and is left out.",
	previewEmailPartsSkipped_other: "{{count}} parts of this message could not be read and are left out.",
	/** Email preview — reading the message failed */
	previewEmailFailed: "The message could not be read."
}
