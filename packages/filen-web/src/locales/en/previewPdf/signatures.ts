// "preview" namespace, PDF viewer — digital signatures: the one-line status under the command bar and the Signatures
// dialog. Nothing here vouches for who signed: the identity is never checked against a trust list or for revocation,
// and every string says only what was checked. Spread into previewPdf/index.ts; same catalog rules.
export const previewPdfSignatures = {
	/** PDF signature status line while the document's signatures are being checked */
	previewPdfSignatureChecking: "Checking signatures…",
	/** PDF signature status line: the latest signature's signed bytes verify and nothing was added after them. {{name}} is the name in the signer's certificate (never verified against a trust list) */
	previewPdfSignatureBannerUnchanged: "Signed by {{name}} · unchanged since signing · signer not verified",
	/** PDF signature status line: the signature verifies, and the document was changed afterwards only in ways the signer allowed (filling in forms, adding annotations or more signatures). The signer is never verified */
	previewPdfSignatureBannerChangedAllowed: "Signed by {{name}} · changed after signing, in ways the signer allowed · signer not verified",
	/** PDF signature status line: the signature verifies, but the document was changed afterwards in ways the signer did not allow. The signer is never verified */
	previewPdfSignatureBannerChangedNotAllowed:
		"Signed by {{name}} · changed after signing, in ways the signer didn't allow · signer not verified",
	/** PDF signature status line: a signature failed a check or couldn't be checked in this browser. {{reason}} is one of the previewPdfSignatureInvalid… or previewPdfSignatureUnverifiable… sentences */
	previewPdfSignatureBannerInvalid: "Invalid signature by {{name}}: {{reason}}",
	/** PDF signature status line when the signatures could not be read at all (a read failed) */
	previewPdfSignatureCheckFailed: "The signatures couldn't be checked.",
	/** Button on the failed signature status line, checking again */
	previewPdfSignatureRetry: "Try again",
	/** Stands in for the signer's name when the certificate carries none */
	previewPdfSignatureUnknownSigner: "an unknown signer",
	/** Button on the signature status line opening the Signatures dialog */
	previewPdfSignatureDetails: "Details",
	/** Button on the signature status line opening the document as it was when signed (the signed revision, read-only) */
	previewPdfSignatureViewSigned: "View signed version",
	/** Status line while the signed version of a document is shown instead of the current one */
	previewPdfSignatureViewingSigned: "This is the document as it was signed.",
	/** Button on that status line returning to the current version of the document */
	previewPdfSignatureViewCurrent: "Back to current version",

	/** Title of the dialog listing a PDF's signatures */
	previewPdfSignaturesTitle: "Signatures",
	/** Signatures dialog: the three states of one signature, as a heading of its entry (exact wording; the signer is never verified) */
	previewPdfSignatureStateUnchanged: "Unchanged since signing · signer not verified",
	/** Signatures dialog: entry heading of a signature followed by later changes */
	previewPdfSignatureStateChanged: "Changed after signing",
	/** Signatures dialog: entry heading of a signature that failed a check */
	previewPdfSignatureStateInvalid: "Invalid",
	/** Signatures dialog: entry heading of a signature that could not be checked in this browser */
	previewPdfSignatureStateUnverifiable: "Can't verify",
	/** Signatures dialog: the changes after signing were all ones the signer allowed. {{kinds}} lists them (previewPdfSignatureChange… joined by commas) */
	previewPdfSignatureChangesAllowed: "Allowed changes: {{kinds}}",
	/** Signatures dialog: the changes after signing include ones the signer did not allow. {{kinds}} lists them */
	previewPdfSignatureChangesNotAllowed: "Changes the signer didn't allow: {{kinds}}",
	/** Signatures dialog: a later revision exists but changed nothing visible */
	previewPdfSignatureChangesNone: "A later revision was added without visible changes",
	/** A kind of change after signing: form field values */
	previewPdfSignatureChangeForm: "form filling",
	/** A kind of change after signing: comments and markups */
	previewPdfSignatureChangeAnnotation: "annotations",
	/** A kind of change after signing: more signatures */
	previewPdfSignatureChangeSignature: "signatures",
	/** A kind of change after signing: validation data (certificates, revocation answers) added for long-term checks */
	previewPdfSignatureChangeDss: "validation data",
	/** A kind of change after signing: the document's pages, text or structure */
	previewPdfSignatureChangeContent: "content",
	/** Signatures dialog: shown for every signature (exact wording) */
	previewPdfSignatureSignerNotVerified:
		"The signer's identity isn't verified. Filen doesn't check certificates against a trust list or for revocation.",
	/** Signatures dialog: the time the signer wrote into the signature (exact wording). {{time}} is a date and time */
	previewPdfSignatureClaimedTime: "Time stated by the signer: {{time}}. This isn't a trusted timestamp.",
	/** Signatures dialog: a signature with an embedded timestamp token. {{time}} is the token's date and time; the timestamp authority itself is not verified */
	previewPdfSignatureTimestamped: "Timestamped {{time}} (the timestamp authority isn't verified)",
	/** Signatures dialog: a signature without a timestamp token */
	previewPdfSignatureNoTimestamp: "No timestamp: this signature isn't set up for long-term validation.",
	/** Signatures dialog: label of a document timestamp (a timestamp of the whole document, not a person's signature) */
	previewPdfSignatureDocumentTimestamp: "Document timestamp",
	/** Signatures dialog: the certificate had expired at the time the signer stated */
	previewPdfSignatureExpired: "The certificate had expired at the time stated by the signer.",
	/** Signatures dialog: the certificate was not yet valid at the time the signer stated */
	previewPdfSignatureNotYetValid: "The certificate wasn't valid yet at the time stated by the signer.",
	/** Signatures dialog: the signer's certificate is self-signed (issued by the signer to themselves) */
	previewPdfSignatureSelfSigned: "Self-signed certificate",
	/** Signatures dialog: the document carries validation data (a Document Security Store); it is shown but not used */
	previewPdfSignatureDss: "The document contains validation data, which isn't used for this check.",
	/** Signatures dialog: certification level 1 of a certifying signature */
	previewPdfSignatureCertifiedNone: "Certified: no changes allowed",
	/** Signatures dialog: certification level 2 */
	previewPdfSignatureCertifiedForms: "Certified: filling in forms and signing allowed",
	/** Signatures dialog: certification level 3 */
	previewPdfSignatureCertifiedAnnotations: "Certified: filling in forms, signing and annotations allowed",
	/** Signatures dialog field label: the field holding the signature */
	previewPdfSignatureField: "Field",
	/** Signatures dialog field label: page of the signature's field. Value like "3" */
	previewPdfSignaturePage: "Page",
	/** Signatures dialog field label: which revision of the document the signature closes. Value is previewPdfSignatureRevisionOf */
	previewPdfSignatureRevision: "Revision",
	/** Value of the Revision row: {{revision}} of {{total}} saved revisions */
	previewPdfSignatureRevisionOf: "{{revision}} of {{total}}",
	/** Signatures dialog field label: the name the signer gave */
	previewPdfSignatureName: "Name",
	/** Signatures dialog field label: the reason the signer gave */
	previewPdfSignatureReason: "Reason",
	/** Signatures dialog field label: the place the signer gave */
	previewPdfSignatureLocation: "Location",
	/** Signatures dialog field label: the contact the signer gave */
	previewPdfSignatureContact: "Contact",
	/** Signatures dialog field label: the certificate's subject (who it was issued to) */
	previewPdfSignatureSubject: "Issued to",
	/** Signatures dialog field label: the certificate's issuer */
	previewPdfSignatureIssuer: "Issued by",
	/** Signatures dialog field label: the certificate's serial number */
	previewPdfSignatureSerial: "Serial number",
	/** Signatures dialog field label: the certificate's validity period. Value is previewPdfSignatureValidityRange */
	previewPdfSignatureValidity: "Valid",
	/** Value of the Valid row: {{from}} and {{until}} are dates */
	previewPdfSignatureValidityRange: "{{from}} to {{until}}",
	/** Signatures dialog field label: the signature's algorithm, like "ECDSA P-256 with SHA-256" */
	previewPdfSignatureAlgorithm: "Algorithm",
	/** Value of the Algorithm row: {{algorithm}} like "RSA 2048", {{digest}} like "SHA-256" */
	previewPdfSignatureAlgorithmWith: "{{algorithm}} with {{digest}}",
	/** Signatures dialog field label: the certificates from the signer's up to the last issuer found in the signature */
	previewPdfSignatureChain: "Certificate chain",
	/** Shown for an empty value in the Signatures dialog */
	previewPdfSignatureNone: "—",

	/** Why a signature is invalid: its byte range is malformed */
	previewPdfSignatureInvalidByteRange: "its byte range is malformed",
	/** Why a signature is invalid: the excluded bytes are not exactly the signature */
	previewPdfSignatureInvalidContentsGap: "it leaves out more than the signature itself",
	/** Why a signature is invalid: the signed bytes don't end where a saved revision ends */
	previewPdfSignatureInvalidNotAtRevisionEnd: "it doesn't cover a whole saved revision",
	/** Why a signature is invalid: the signature's own data was replaced or moved */
	previewPdfSignatureInvalidDictionaryChanged: "its signature data was replaced after signing",
	/** Why a signature is invalid: the signature data cannot be read */
	previewPdfSignatureInvalidMalformed: "its signature data is malformed",
	/** Why a signature is invalid: it has other than exactly one signer */
	previewPdfSignatureInvalidSignerCount: "it doesn't have exactly one signer",
	/** Why a signature is invalid: it carries its own content instead of signing the file */
	previewPdfSignatureInvalidNotDetached: "it doesn't sign the file's bytes",
	/** Why a signature is invalid: the document's bytes don't match what was signed */
	previewPdfSignatureInvalidDigest: "the document was altered",
	/** Why a signature is invalid: the cryptographic signature doesn't match the certificate */
	previewPdfSignatureInvalidSignature: "the signature doesn't match the certificate",
	/** Why a signature is invalid: SHA-1 or MD5 */
	previewPdfSignatureInvalidWeakDigest: "it uses an outdated hash algorithm (SHA-1 or MD5)",
	/** Why a signature is invalid: RSA key shorter than 2048 bits */
	previewPdfSignatureInvalidWeakKey: "its key is too short",
	/** Why a signature is invalid: a signature format that isn't supported */
	previewPdfSignatureInvalidSubFilter: "its format isn't supported",
	/** Why a signature is invalid: the signer's certificate is missing */
	previewPdfSignatureInvalidCertificateMissing: "the signer's certificate is missing",
	/** Why a document timestamp is invalid: it doesn't cover the document */
	previewPdfSignatureInvalidTimestamp: "its timestamp doesn't match the document",
	/** Why a signature can't be verified: an algorithm this browser lacks (Brainpool curves, Ed25519 in some browsers) */
	previewPdfSignatureUnverifiableAlgorithm: "it uses an algorithm this browser can't check",
	/** Why a signature can't be verified: two ways of reading the file disagree about its signatures */
	previewPdfSignatureUnverifiableParserMismatch: "the file can be read in two different ways",
	/** Why a signature can't be verified: the file is damaged */
	previewPdfSignatureUnverifiableDamaged: "the file is damaged",
	/** Why a signature can't be verified: the file couldn't be read */
	previewPdfSignatureUnverifiableReadFailed: "the file couldn't be read"
} as const
