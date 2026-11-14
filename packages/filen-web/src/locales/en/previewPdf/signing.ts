// "preview" namespace, PDF editor — signing with a certificate: the certificate signing dialog and the confirm before a
// save that invalidates signatures. The certificate's key is used only in the browser and never stored; no string
// claims more (nobody checks the signer's identity, and the signing time is the signer's own claim). Spread into
// preview.ts; same catalog rules.
export const previewPdfSigning = {
	/** Title of the dialog that signs a PDF with a digital certificate (a .p12/.pfx file holding a private key) */
	previewPdfSigningTitle: "Sign with a certificate",
	/** Certificate signing dialog: what the dialog does */
	previewPdfSigningDescription: "Choose your certificate file (.p12 or .pfx). Its key is used only in this browser and isn't stored.",
	/** Certificate signing dialog: label of the certificate file choice */
	previewPdfSigningCertificate: "Certificate",
	/** Certificate signing dialog: button picking the certificate file from the user's Filen drive */
	previewPdfSigningFromFilen: "From Filen…",
	/** Certificate signing dialog: button picking the certificate file from this device */
	previewPdfSigningFromDevice: "From device",
	/** Title of the drive file picker opened by "From Filen…" */
	previewPdfSigningPickerTitle: "Choose a certificate",
	/** Description of the drive file picker: which files are listed */
	previewPdfSigningPickerDescription: "Certificate files (.p12, .pfx) in your drive.",
	/** Certificate signing dialog: shown while the chosen certificate file is read */
	previewPdfSigningLoading: "Reading the certificate…",
	/** Certificate signing dialog: label of the certificate file's password field */
	previewPdfSigningPassword: "Password",
	/** Certificate signing dialog: note under the password field (it is used once and kept nowhere) */
	previewPdfSigningPasswordNotStored: "Not stored",
	/** Certificate signing dialog: button opening the certificate with the typed password */
	previewPdfSigningUnlock: "Unlock",
	/** Certificate signing dialog: shown while the certificate is being opened with the password */
	previewPdfSigningUnlocking: "Unlocking…",
	/** Certificate signing dialog: the signer named in the certificate. {{name}} is that name (never verified) */
	previewPdfSigningSigner: "Signer: {{name}}",
	/** Certificate signing dialog: who issued the certificate. {{issuer}} is the issuer's name */
	previewPdfSigningIssuer: "Issued by {{issuer}}",
	/** Certificate signing dialog: the certificate's expiry date. {{date}} is the date */
	previewPdfSigningExpires: "Expires {{date}}",
	/** Certificate signing dialog warning: the certificate has expired. {{date}} is the expiry date */
	previewPdfSigningExpired: "This certificate expired on {{date}}. Signatures made with it show as expired.",
	/** Certificate signing dialog warning: the certificate's validity has not started yet. {{date}} is its start date */
	previewPdfSigningNotYetValid: "This certificate is valid only from {{date}}.",
	/** Certificate signing dialog note: the certificate was issued by its own owner, not by a certificate authority */
	previewPdfSigningSelfSigned: "Self-signed: no certificate authority vouches for this signer.",
	/** Certificate signing dialog: label of the signing reason choice */
	previewPdfSigningReason: "Reason",
	/** Signing reason choice: no reason given */
	previewPdfSigningReasonNone: "None",
	/** A signing reason written into the signature: the signer approves the document */
	previewPdfSigningReasonApprove: "I approve this document",
	/** A signing reason written into the signature: the signer reviewed the document */
	previewPdfSigningReasonReviewed: "I have reviewed this document",
	/** A signing reason written into the signature: the signer wrote the document */
	previewPdfSigningReasonAuthor: "I am the author of this document",
	/** A signing reason written into the signature: the signer confirms the document is accurate */
	previewPdfSigningReasonAttest: "I attest to the accuracy and integrity of this document",
	/** A signing reason written into the signature: the signer agrees to the document's terms */
	previewPdfSigningReasonAgree: "I agree to the terms of this document",
	/** Certificate signing dialog: label of the optional place of signing */
	previewPdfSigningLocation: "Location",
	/** Certificate signing dialog: placeholder of the location field */
	previewPdfSigningLocationPlaceholder: "Optional, e.g. Berlin",
	/** Certificate signing dialog: label of the choice of what the signature shows on the page */
	previewPdfSigningAppearance: "Appearance",
	/** Signature appearance choice: the signer's name and the date */
	previewPdfSigningAppearanceNameDate: "Name and date",
	/** Signature appearance choice: the signer's name, the date and the reason */
	previewPdfSigningAppearanceDetails: "Name, date and reason",
	/** Signature appearance choice: the user's drawn or image signature beside the name and date */
	previewPdfSigningAppearanceVisual: "My signature, name and date",
	/** Certificate signing dialog: label of the certification choice (a certifying signature also sets which later changes stay allowed) */
	previewPdfSigningCertify: "Certify",
	/** Certification choice: an ordinary signature that does not certify the document */
	previewPdfSigningCertifyNone: "Don't certify",
	/** Certification choice: certify; no later changes are allowed */
	previewPdfSigningCertifyNoChanges: "Certify, allow no changes",
	/** Certification choice: certify; filling in forms and adding signatures stay allowed */
	previewPdfSigningCertifyForms: "Certify, allow form filling and signing",
	/** Certification choice: certify; form filling, signing and annotations stay allowed */
	previewPdfSigningCertifyAnnotations: "Certify, allow form filling, signing and annotations",
	/** Certificate signing dialog: why certifying is unavailable (only the first signature can certify) */
	previewPdfSigningCertifyUnavailable: "Only the first signature in a document can certify it.",
	/** Certificate signing dialog: button that closes the dialog so the user draws where the signature goes on a page */
	previewPdfSigningPlace: "Place signature on page",
	/** Text shown inside the placed signature: who signed. {{name}} is the signer's name from the certificate */
	previewPdfSigningStampSignedBy: "Digitally signed by {{name}}",
	/** Text shown inside the placed signature: when. {{date}} is the date and time the signer claims */
	previewPdfSigningStampDate: "Date: {{date}}",
	/** Text shown inside the placed signature: why. {{reason}} is the chosen reason */
	previewPdfSigningStampReason: "Reason: {{reason}}",
	/** Certificate signing error: the password does not open the certificate file */
	previewPdfSigningErrorPassword: "That password is incorrect.",
	/** Certificate signing error: the file is not a certificate file that can be read */
	previewPdfSigningErrorMalformed: "This isn't a certificate file Filen can read (.p12 or .pfx).",
	/** Certificate signing error: the certificate file holds no private key */
	previewPdfSigningErrorNoKey: "This certificate file has no private key, so it can't sign.",
	/** Certificate signing error: the certificate file holds no certificate */
	previewPdfSigningErrorNoCertificate: "This file holds no certificate.",
	/** Certificate signing error: the key type or curve is one browsers can't use (for example Brainpool) */
	previewPdfSigningErrorAlgorithm: "This certificate uses an algorithm this browser can't check.",
	/** Certificate signing error: the RSA key is shorter than 2048 bits */
	previewPdfSigningErrorWeakKey: "This certificate's key is too short to sign securely.",
	/** Certificate signing error: the private key and the certificate in the file don't belong together */
	previewPdfSigningErrorKeyMismatch: "The private key in this file doesn't belong to its certificate.",
	/** Certificate signing error: the certificate file could not be read (download failed, file unreadable) */
	previewPdfSigningErrorReadFailed: "The certificate file couldn't be read.",
	/** Certificate signing error: the chosen file is far too large to be a certificate file */
	previewPdfSigningErrorTooLarge: "This file is too large to be a certificate file.",

	/** Title of the confirm shown before a save that breaks the document's digital signatures */
	previewPdfSigningInvalidateTitle: "Invalidate signatures?",
	/** Confirm before a save that breaks digital signatures, one signature (exact wording) */
	previewPdfSigningInvalidate_one: "Saving these changes invalidates {{count}} signature.",
	/** Confirm before a save that breaks digital signatures, several signatures (exact wording) */
	previewPdfSigningInvalidate_other: "Saving these changes invalidates {{count}} signatures.",
	/** Button of that confirm: save and break the signatures */
	previewPdfSigningInvalidateConfirm: "Save anyway",
	/** Ribbon button (Protect tab) that signs the PDF with a certificate file */
	previewPdfSigningTool: "Sign with certificate",
	/** One-line notice when unsaved changes are too large to save together with the signature (exact wording) */
	previewPdfSignAfterChanges: "To sign, Filen first saves your changes as a new version, then saves the signed version.",
	/** One-line hint under the ribbon while the user places the signature on a page */
	previewPdfSigningPlaceHint:
		"Drag on a page to place your signature, or choose an empty signature field. On a page, Enter places it with the keyboard.",
	/** Button in that hint: stop signing */
	previewPdfSigningPlaceCancel: "Cancel",
	/** Accessible name of a page while the signature is placed on it; {{page}} is the page number */
	previewPdfSigningPlaceOnPage: "Place the signature on page {{page}}",
	/** Button over an empty signature field of the form: sign in this field */
	previewPdfSigningSignHere: "Sign here",
	/** One-line status under the ribbon while the signature is made and the signed PDF saved */
	previewPdfSigningSaving: "Signing and saving…",
	/** Message after the signed PDF was saved as a new version */
	previewPdfSigningSigned: "Signed and saved",
	/** Error when signing did not complete (nothing was saved) */
	previewPdfSigningFailed: "The PDF couldn't be signed. Nothing was saved."
} as const
