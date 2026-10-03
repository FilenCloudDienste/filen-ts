// English source catalog — "archive" namespace: compress and extract in the drive — the Compress and
// Extract submenus, the compress and extract dialogs, the password prompt and the job report. The job's
// card and transfers row stay in "transfers". Same typed-catalog rules as common/drive/transfers: flat
// `as const` object, camelCase keys, no literal '.' or ':' (real i18next namespaces, keySeparator/
// nsSeparator both ON). Keys ending in `_<reason>` are picked by an SDK reason, not by i18next.
// "directory" never "folder".
export const archive = {
	// ── Formats ──────────────────────────────────────────────────────────────
	/** Compress dialog format list — ZIP archive */
	archiveFormatZip: "ZIP",
	/** Compress dialog format list — one-line hint under archiveFormatZip */
	archiveFormatZipHint: "Opens on every system; can have a password",
	/** Compress dialog format list — 7-Zip archive */
	archiveFormatSevenZ: "7-Zip",
	/** Compress dialog format list — one-line hint under archiveFormatSevenZ */
	archiveFormatSevenZHint: "Smallest archives; a password can hide the file names too",
	/** Compress dialog format list — tar archive compressed with gzip (.tar.gz) */
	archiveFormatTarGz: "Tarball, gzip",
	/** Compress dialog format list — one-line hint under archiveFormatTarGz */
	archiveFormatTarGzHint: "Common on Linux and macOS; quick to make",
	/** Compress dialog format list — tar archive compressed with xz (.tar.xz) */
	archiveFormatTarXz: "Tarball, xz",
	/** Compress dialog format list — one-line hint under archiveFormatTarXz */
	archiveFormatTarXzHint: "Smaller than gzip, slower to make",
	/** Compress dialog format list — tar archive compressed with Zstandard (.tar.zst) */
	archiveFormatTarZst: "Tarball, Zstandard",
	/** Compress dialog format list — one-line hint under archiveFormatTarZst */
	archiveFormatTarZstHint: "Small, and quick to make and open",
	/** Compress dialog format list — tar archive without compression (.tar) */
	archiveFormatTar: "Tarball, uncompressed",
	/** Compress dialog format list — one-line hint under archiveFormatTar */
	archiveFormatTarHint: "Bundles the items without compressing them",
	/** Compress dialog format list — tar archive compressed with bzip2 (.tar.bz2) */
	archiveFormatTarBz2: "Tarball, bzip2",
	/** Compress dialog format list — one-line hint under archiveFormatTarBz2 */
	archiveFormatTarBz2Hint: "Older and slower; for tools that expect it",
	/** Compress dialog format list — tar archive compressed with LZ4 (.tar.lz4) */
	archiveFormatTarLz4: "Tarball, LZ4",
	/** Compress dialog format list — one-line hint under archiveFormatTarLz4 */
	archiveFormatTarLz4Hint: "Fastest to make and open, but larger",
	/** Compress dialog format list — tar archive compressed with Brotli (.tar.br) */
	archiveFormatTarBr: "Tarball, Brotli",
	/** Compress dialog format list — one-line hint under archiveFormatTarBr */
	archiveFormatTarBrHint: "Small; few desktop apps open it",
	/** Compress dialog format list — tar archive compressed with lzip (.tar.lz) */
	archiveFormatTarLz: "Tarball, lzip",
	/** Compress dialog format list — one-line hint under archiveFormatTarLz */
	archiveFormatTarLzHint: "Like xz, in a simpler format",
	/** Compress dialog format list — tar archive compressed with LZMA (.tar.lzma) */
	archiveFormatTarLzma: "Tarball, LZMA",
	/** Compress dialog format list — one-line hint under archiveFormatTarLzma */
	archiveFormatTarLzmaHint: "The older format xz replaced",
	/** Compress dialog format list — one file compressed with gzip (.gz); offered only when exactly one file is selected */
	archiveFormatGz: "gzip",
	/** Compress dialog format list — one-line hint under archiveFormatGz */
	archiveFormatGzHint: "Compresses this one file; quick and widely supported",
	/** Compress dialog format list — one file compressed with bzip2 (.bz2) */
	archiveFormatBz2: "bzip2",
	/** Compress dialog format list — one-line hint under archiveFormatBz2 */
	archiveFormatBz2Hint: "Compresses this one file; older and slower",
	/** Compress dialog format list — one file compressed with xz (.xz) */
	archiveFormatXz: "xz",
	/** Compress dialog format list — one-line hint under archiveFormatXz */
	archiveFormatXzHint: "Compresses this one file; small, slower to make",
	/** Compress dialog format list — one file compressed with LZMA (.lzma) */
	archiveFormatLzma: "LZMA",
	/** Compress dialog format list — one-line hint under archiveFormatLzma */
	archiveFormatLzmaHint: "Compresses this one file; the older format xz replaced",
	/** Compress dialog format list — one file compressed with lzip (.lz) */
	archiveFormatLz: "lzip",
	/** Compress dialog format list — one-line hint under archiveFormatLz */
	archiveFormatLzHint: "Compresses this one file; like xz, in a simpler format",
	/** Compress dialog format list — one file compressed with LZ4 (.lz4) */
	archiveFormatLz4: "LZ4",
	/** Compress dialog format list — one-line hint under archiveFormatLz4 */
	archiveFormatLz4Hint: "Compresses this one file; fastest, but larger",
	/** Compress dialog format list — one file compressed with Brotli (.br) */
	archiveFormatBr: "Brotli",
	/** Compress dialog format list — one-line hint under archiveFormatBr */
	archiveFormatBrHint: "Compresses this one file; small, few desktop apps open it",
	/** Compress dialog format list — one file compressed with Zstandard (.zst) */
	archiveFormatZst: "Zstandard",
	/** Compress dialog format list — one-line hint under archiveFormatZst */
	archiveFormatZstHint: "Compresses this one file; small, and quick to make and open",
	/** Compress dialog format list — group heading over ZIP, 7-Zip and the usual tarballs */
	archiveFormatGroupCommon: "Common",
	/** Compress dialog format list — group heading over the other tarballs */
	archiveFormatGroupMore: "More formats",
	/** Compress dialog format list — group heading over the formats that compress one file on its own */
	archiveFormatGroupSingle: "Single file",
	/** Compress dialog format list — hint on a format whose lowest level needs more than the archive memory set in Advanced settings */
	archiveFormatUnavailable: "Needs more archive memory",

	// ── Compress menu and dialog ─────────────────────────────────────────────
	/** Compress submenu — compresses the selection into a ZIP archive at once, with the options last used for ZIP */
	archiveCompressPresetZip: "ZIP (.zip)",
	/** Compress submenu — compresses the selection into a 7-Zip archive at once, with the options last used for 7-Zip */
	archiveCompressPresetSevenZ: "7-Zip (.7z)",
	/** Compress submenu — compresses the selection into a gzip tarball at once, with the level last used for it */
	archiveCompressPresetTarGz: "Tarball (.tar.gz)",
	/** Compress submenu — last entry; opens the compress dialog with every format and option */
	archiveCompressMoreOptions: "More options…",
	/** Compress dialog — title */
	archiveCompressTitle: "Compress",
	/** Compress dialog — description under the title */
	archiveCompressDescription: "Packs the selected items into one archive in your Cloud Drive.",
	/** Compress dialog for a public link's item — title */
	archiveSaveAsTitle: "Save as archive",
	/** Compress dialog for a public link's item — description; {{name}} is the linked file or directory */
	archiveSaveAsDescription: "Packs “{{name}}” into one archive in your Cloud Drive.",
	/** Compress dialog — label of the archive's name field; the format's extension follows the field */
	archiveCompressNameLabel: "Name",
	/** Compress dialog — label of the format dropdown */
	archiveCompressFormatLabel: "Format",
	/** Compress dialog — label before the destination directory's name */
	archiveSaveInLabel: "Save in",
	/** Extract dialog — label before the destination directory's name */
	archiveExtractToLabel: "Extract to",
	/** Compress and extract dialogs — button opening the destination picker */
	archiveChangeDestination: "Change…",
	/** Compress dialog — label of the compression level slider */
	archiveLevelLabel: "Compression level",
	/** Compress dialog — line under the level slider; {{level}} = the chosen level, {{memory}} = formatted memory it takes */
	archiveLevelValue: "Level {{level}} · uses about {{memory}} while compressing",
	/** Compress dialog — label at the slider's low end */
	archiveLevelFaster: "Faster",
	/** Compress dialog — label at the slider's high end */
	archiveLevelSmaller: "Smaller",
	/** Compress dialog — note under a slider whose top levels are locked; {{from}}–{{to}} = the locked levels, {{budget}} = formatted archive memory setting */
	archiveLevelLocked: "Levels {{from}}–{{to}} need more than the {{budget}} of archive memory set in Advanced settings",
	/** Compress dialog — replaces the level slider for a format or method that does not compress (plain tar, stored ZIP, copy 7-Zip) */
	archiveLevelNone: "No compression",
	/** Compress dialog — switch adding a password to the archive */
	archiveProtectLabel: "Protect with a password",
	/** Compress dialog — hint on the disabled password switch for a format that cannot hold one */
	archiveProtectUnsupported: "Only ZIP and 7-Zip archives can have a password",
	/** Compress and extract dialogs — label of the password field */
	archivePasswordLabel: "Password",
	/** Compress dialog — label of the field repeating the password */
	archivePasswordConfirmLabel: "Confirm password",
	/** Compress dialog — error under the confirm field while it differs from the password */
	archivePasswordMismatch: "The passwords don't match",
	/** Compress dialog — error under an empty password field once the user tried to compress */
	archivePasswordEmpty: "Enter a password",
	/** Archive password fields — error under a password longer than archives allow; {{max}} = the most characters */
	archivePasswordTooLong: "A password can have at most {{max}} characters",
	/** Password fields — accessible label on the button revealing the typed password */
	archivePasswordShow: "Show password",
	/** Password fields — accessible label on the button hiding the typed password again */
	archivePasswordHide: "Hide password",
	/** Compress dialog — 7-Zip only: switch encrypting the archive's list of names too, so they need the password to be read */
	archiveEncryptNames: "Also encrypt file names",
	/** Compress dialog — collapsible section with method, solid and encryption strength */
	archiveAdvanced: "Advanced",
	/** Compress dialog — label of the compression method dropdown (ZIP and 7-Zip) */
	archiveMethodLabel: "Method",
	/** Compress dialog method — ZIP: files stored as they are */
	archiveMethodStored: "Stored (no compression)",
	/** Compress dialog method — Deflate, ZIP's usual method (also a 7-Zip method) */
	archiveMethodDeflate: "Deflate",
	/** Compress dialog method — BZip2 (ZIP and 7-Zip) */
	archiveMethodBzip2: "BZip2",
	/** Compress dialog method — LZMA2, 7-Zip's usual method */
	archiveMethodLzma2: "LZMA2",
	/** Compress dialog method — LZMA (7-Zip) */
	archiveMethodLzma: "LZMA",
	/** Compress dialog method — PPMd, best for text (7-Zip) */
	archiveMethodPpmd: "PPMd",
	/** Compress dialog method — 7-Zip: files copied in as they are */
	archiveMethodCopy: "Copy (no compression)",
	/** Compress dialog — 7-Zip only: switch compressing the files as one stream */
	archiveSolidLabel: "Solid archive",
	/** Compress dialog — hint under archiveSolidLabel */
	archiveSolidHint: "Compresses the files together into a smaller archive; reading one file reads those before it",
	/** Compress dialog — ZIP with a password only: label of the AES key length dropdown */
	archiveAesLabel: "Encryption strength",
	/** Compress dialog encryption strength — AES with a 128-bit key */
	archiveAes128: "AES-128",
	/** Compress dialog encryption strength — AES with a 192-bit key */
	archiveAes192: "AES-192",
	/** Compress dialog encryption strength — AES with a 256-bit key */
	archiveAes256: "AES-256",
	/** Compress dialog — submit button */
	archiveCompressSubmit: "Compress",
	/** The archive's name when the items have no common parent directory to name it after, or lie in My Drive's root */
	archiveDefaultName: "Archive",
	/** Compress and extract dialogs — error under an empty name */
	archiveName_Empty: "Enter a name",
	/** Compress and extract dialogs — error under a name longer than 255 bytes */
	archiveName_TooLong: "This name is too long",
	/** Compress and extract dialogs — error under a name holding a character no file system takes */
	archiveName_ForbiddenChar: "Names can't contain \\ / : * ? \" < > | or control characters",
	/** Compress and extract dialogs — error under a device name Windows reserves (CON, PRN, AUX, NUL, COM1–9, LPT1–9) */
	archiveName_ReservedName: "This name is reserved by Windows",
	/** Compress and extract dialogs — error under a name ending in a dot or a space */
	archiveName_TrailingDotOrSpace: "Names can't end with a dot or a space",
	/** Compress and extract dialogs — error under a name starting with a space */
	archiveName_LeadingSpace: "Names can't start with a space",
	/** Compress and extract dialogs — error under the name "." or ".." */
	archiveName_DotEntry: "Names can't be . or ..",
	/** Compress dialog — error when a single-file format is chosen for anything but exactly one file */
	archiveSingleNeedsOneFile: "This format compresses exactly one file",
	/** Compress dialog — error under a name that reads as another archive format (a file named backup.tar compressed with gzip would be backup.tar.gz, a tarball) */
	archiveNameOtherFormat: "This name reads as a different archive format. Change the name or the format.",
	/** Compress destination picker — title */
	archiveCompressPickTitle: "Save archive in",
	/** Compress destination picker — button saving the archive in the directory open or picked */
	archiveCompressPickConfirm: "Save here",

	// ── Afterwards ───────────────────────────────────────────────────────────
	/** Compress and extract dialogs — label of the choice what happens to the originals (the items, or the archive) once the job is done */
	archiveAfterwardsLabel: "Afterwards",
	/** Compress and extract dialogs, Afterwards choice — hint under the choice keeping the originals or the archive */
	archiveAfterwardsKeepHint: "Nothing is removed.",
	/** Compress dialog, Afterwards choice — leave the selected items where they are (the default) */
	archiveAfterwardsKeep: "Keep the originals",
	/** Compress dialog, Afterwards choice — move the selected items to the trash once the archive is checked */
	archiveAfterwardsTrash: "Move the originals to the trash",
	/** Compress dialog, Afterwards choice — hint under archiveAfterwardsTrash */
	archiveAfterwardsTrashHint: "Once the result is checked. You can restore them from the trash.",
	/** Compress dialog, Afterwards choice — delete the selected items for good once the archive is checked */
	archiveAfterwardsDelete: "Delete the originals permanently",
	/** Compress dialog, Afterwards choice — hint under archiveAfterwardsDelete */
	archiveAfterwardsDeleteHint: "Once the result is checked. They will not be in the trash.",
	/** Extract dialog, Afterwards choice — leave the archive where it is (the default) */
	archiveAfterwardsKeepArchive: "Keep the archive",
	/** Extract dialog, Afterwards choice — move the archive to the trash once everything is extracted and checked */
	archiveAfterwardsTrashArchive: "Move the archive to the trash",
	/** Extract dialog, Afterwards choice — hint under archiveAfterwardsTrashArchive */
	archiveAfterwardsTrashArchiveHint: "Once everything is extracted and checked. You can restore it from the trash.",
	/** Extract dialog, Afterwards choice — delete the archive for good once everything is extracted and checked */
	archiveAfterwardsDeleteArchive: "Delete the archive permanently",
	/** Extract dialog, Afterwards choice — hint under archiveAfterwardsDeleteArchive */
	archiveAfterwardsDeleteArchiveHint: "Once everything is extracted and checked. It will not be in the trash.",
	/** Confirmation before a job that deletes its originals permanently — title */
	archiveDeleteConfirmTitle: "Delete permanently?",
	/** Compress delete confirmation — body; {{count}} = items selected; singular */
	archiveDeleteConfirmBodyCompress_one:
		"After the archive is saved it is downloaded again and checked; only then is the original deleted permanently. It will not be in the trash.",
	/** Compress delete confirmation — body; {{count}} = items selected; plural */
	archiveDeleteConfirmBodyCompress_other:
		"After the archive is saved it is downloaded again and checked; only then are the {{count}} originals deleted permanently. They will not be in the trash.",
	/** Compress delete confirmation — added when the archive has a password */
	archiveDeleteConfirmPasswordNote: "The check uses the password you typed, which is why it was entered twice.",
	/** Extract delete confirmation — body */
	archiveDeleteConfirmBodyExtract:
		"Once everything is extracted and checked, the archive is deleted permanently. It will not be in the trash.",
	/** Extract delete confirmation — added when macOS metadata is skipped */
	archiveDeleteConfirmMacNote: "macOS metadata left out goes with it.",
	/** Delete confirmation — destructive button starting the job */
	archiveDeleteConfirmAction: "Delete permanently",

	// ── Extract menu ─────────────────────────────────────────────────────────
	/** Extract submenu — extracts into a new directory next to the archive; {{name}} = the directory's name */
	archiveExtractHereNewFolder: "Extract here to “{{name}}/”",
	/** Extract submenu — extracts the archive's contents straight into its own directory */
	archiveExtractHere: "Extract here",
	/** Extract submenu — a single compressed file (.gz, .xz, …): extracts it next to itself; {{name}} = the file it becomes */
	archiveExtractHereSingle: "Extract here as “{{name}}”",
	/** Extract submenu — submenu with the directory tree; also the bulk Extract submenu's */
	archiveExtractTo: "Extract to",
	/** Extract submenu — opens the destination picker */
	archiveExtractChooseDestination: "Choose destination…",
	/** Extract submenu — opens the extract dialog with every option */
	archiveExtractWithOptions: "Extract with options…",
	/** Extract submenu — opens the archive's contents to browse and extract some of them */
	archiveBrowseContents: "Browse contents",
	/** Bulk Extract submenu — extracts every selected archive next to itself, each into a new directory of its own */
	archiveExtractHereEach: "Extract here (each into its own directory)",

	// ── Extract dialog ───────────────────────────────────────────────────────
	/** Extract dialog — title */
	archiveExtractTitle: "Extract",
	/** Extract dialog — description under the title */
	archiveExtractDescription: "Choose where the archive's contents go.",
	/** Extract dialog — label of the choice where in the destination the archive's contents go */
	archiveExtractRootLabel: "Put the contents",
	/** Extract dialog — choice: create a new directory in the destination and extract into it */
	archiveExtractRootNewFolder: "Into a new directory",
	/** Extract dialog — choice: extract straight into the destination; {{destination}} = its name */
	archiveExtractRootDestination: "Directly into {{destination}}",
	/** Extract dialog — label of the new directory's name field */
	archiveExtractFolderNameLabel: "Directory name",
	/** Extract dialog — note for an archive named like a single compressed file (.gz, .zst, …); {{defaultName}} = the file it becomes. The archive's bytes decide: a tarball named like one still extracts as chosen above */
	archiveExtractSingleNote: "If this is a single compressed file, it extracts as “{{defaultName}}” straight into the destination.",
	/** Extract dialog — collapsible section holding the archive's password field */
	archiveExtractHasPassword: "This archive has a password",
	/** Extract dialog — switch leaving out macOS metadata (on by default) */
	archiveSkipMacLabel: "Skip macOS metadata",
	/** Extract dialog — hint under archiveSkipMacLabel */
	archiveSkipMacHint: "__MACOSX directories and ._ files",
	/** Extract dialog — submit button */
	archiveExtractSubmit: "Extract",
	/** Extract destination picker — title */
	archiveExtractPickTitle: "Extract to",
	/** Extract destination picker — button extracting into the directory open or picked */
	archiveExtractPickConfirm: "Extract here",

	// ── Password prompt ──────────────────────────────────────────────────────
	/** Password prompt — title when the archive needs a password */
	archivePasswordRequiredTitle: "Password required",
	/** Password prompt — title when the password given did not open the archive */
	archiveWrongPasswordTitle: "Wrong password",
	/** Password prompt — body; {{name}} = the archive's name */
	archivePasswordRequiredBody: "“{{name}}” is encrypted. Enter its password to extract it.",
	/** Password prompt — body after a wrong password; {{name}} = the archive's name */
	archiveWrongPasswordBody: "That password didn't open “{{name}}”. Try again.",
	/** Password prompt — switch trying the same password on the other archives waiting for one; {{count}} = how many; singular */
	archivePasswordApplyAll_one: "Also try it for the other archive waiting for a password",
	/** Password prompt — switch trying the same password on the other archives waiting for one; {{count}} = how many; plural */
	archivePasswordApplyAll_other: "Also try it for the {{count}} other archives waiting for a password",
	/** Password prompt — submit button extracting again with the password */
	archivePasswordSubmit: "Extract",

	// ── Report ───────────────────────────────────────────────────────────────
	/** Report dialog — title; lists what a compress or extract failed, skipped, renamed or kept */
	archiveReportTitle: "Report",
	/** Report section — items that failed */
	archiveReportSectionFailed: "Failed",
	/** Report section — items saved under another name than the archive gave */
	archiveReportSectionRenamed: "Renamed",
	/** Report section — names holding invisible or direction-changing characters */
	archiveReportSectionMisleadingNames: "Misleading names",
	/** Report section — names a ZIP lists more than once; only the last of each was extracted */
	archiveReportSectionDuplicates: "Duplicate names",
	/** Report section — originals that were to be removed but were kept, each with the reason */
	archiveReportSectionOriginalsKept: "Originals kept",
	/** Report section — originals removed after the job */
	archiveReportSectionOriginalsRemoved: "Originals removed",
	/** Report section — files whose content did not match the checksum stored with them */
	archiveReportSectionHashMismatches: "Checksum mismatches",
	/** Report section — files saved as a new version of a file of the same name (counted only) */
	archiveReportSectionSavedAsVersion: "Saved as new versions",
	/** Report section — items the destination's shares or public links could not be extended to (counted only) */
	archiveReportSectionPropagationFailed: "Not added to shares or links",
	/** Report skipped section — symbolic links, which the drive cannot hold */
	archiveReportSkipped_symlink: "Symbolic links",
	/** Report skipped section — tar hard links whose file was not extracted */
	archiveReportSkipped_hardlink: "Hard links to missing files",
	/** Report skipped section — device nodes and pipes */
	archiveReportSkipped_device: "Devices and pipes",
	/** Report skipped section — sparse files */
	archiveReportSkipped_sparse: "Sparse files",
	/** Report skipped section — entries of a kind that is not extracted; also any reason this version does not know */
	archiveReportSkipped_unsupportedType: "Unsupported entries",
	/** Report skipped section — paths longer than the drive allows */
	archiveReportSkipped_pathTooLong: "Paths too long",
	/** Report skipped section — paths nested too deeply */
	archiveReportSkipped_pathTooDeep: "Paths nested too deeply",
	/** Report skipped section — paths leading out of the extract's directory, or that cannot be drive names */
	archiveReportSkipped_unsafePath: "Unsafe paths",
	/** Report skipped section — ZIP entries whose data overlaps another's (a damaged or crafted archive) */
	archiveReportSkipped_overlappingData: "Damaged entries",
	/** Report skipped section — entries compressed or encrypted in a way that cannot be read */
	archiveReportSkipped_unsupportedMethod: "Unsupported compression or encryption",
	/** Report skipped section — 7-Zip deletion markers */
	archiveReportSkipped_antiItem: "Deletion markers",
	/** Report skipped section — macOS metadata left out */
	archiveReportSkipped_macMetadata: "macOS metadata",
	/** Report skipped section (compress) — files that could not be decrypted */
	archiveReportSkipped_undecryptableFile: "Files that could not be decrypted",
	/** Report skipped section (compress) — items that could not be reached to list */
	archiveReportSkipped_unreachable: "Items that could not be listed",
	/** Report skipped section — skipped entries past the report's limit, whose reasons are not known */
	archiveReportSkipped_omitted: "Other skipped items",
	/** Report row note — a skipped link's target; {{target}} = the path it points to */
	archiveReportSkippedTarget: "Points to {{target}}",
	/** Report kept-original note — something was not carried over: an entry failed or was skipped */
	archiveReportKept_incomplete: "Not everything was carried over",
	/** Report kept-original note — the archive holds data after its last entry; {{size}} = formatted size */
	archiveReportKept_unaccountedData: "The archive holds {{size}} after its last entry",
	/** Report kept-original note — what was read does not match the stored checksum */
	archiveReportKept_hashMismatch: "Its content didn't match its checksum",
	/** Report kept-original note — no stored checksum to check against, which a permanent deletion needs */
	archiveReportKept_hashUnavailable: "It has no checksum to check against",
	/** Report kept-original note — it moved, was trashed, got a new version or changed contents during the job */
	archiveReportKept_changed: "It changed while the job ran",
	/** Report kept-original note — the result could not be confirmed */
	archiveReportKept_unconfirmed: "The result could not be confirmed",
	/** Report kept-original note — deleting it would lose older versions of a file */
	archiveReportKept_hasVersions: "Deleting it would lose older versions",
	/** Report kept-original note — the job was stopped before it removed it */
	archiveReportKept_interrupted: "The job stopped before removing it",
	/** Report kept-original note — removing it failed (when the error has no text of its own) */
	archiveReportKept_failed: "Removing it failed",
	/** Report row note — renamed item; {{name}} = its new name */
	archiveReportRenamedTo: "Renamed to {{name}}",
	/** Report row note — an original moved to the trash */
	archiveReportRemovedTrash: "Moved to the trash",
	/** Report row note — an original deleted permanently */
	archiveReportRemovedDelete: "Deleted permanently",
	/** Report — line closing a section with more items than it lists; {{count}} = how many more */
	archiveReportOmitted: "{{count}} more not listed",
	/** Report — button on the Failed heading extracting the failed items again */
	archiveReportRetryFailed: "Retry failed",
	/** Report — explanation under the Misleading names heading */
	archiveReportMisleadingExplain: "Names with invisible or direction-changing characters; they may not be what they look like.",
	/** Report — footer button opening the directory the job wrote to */
	archiveReportShowDirectory: "Show directory",

	// ── Quick-action errors ──────────────────────────────────────────────────
	/** Toast when a Compress submenu format cannot run with the archive memory set in Advanced settings; {{format}} = the format's name */
	archiveFormatNeedsMemoryToast:
		"{{format}} needs more archive memory than Advanced settings allow. Raise it there, or choose another format."
} as const
