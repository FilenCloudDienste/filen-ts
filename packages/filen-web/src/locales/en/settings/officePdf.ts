// "settings" namespace — Settings > Office > PDF: how PDFs are saved and the saved Fill & Sign signatures. Spread into
// settings.ts; same catalog rules.
export const settingsOfficePdf = {
	/** Settings > Office — group title: PDF editing */
	settingsOfficePdfTitle: "PDF",
	/** Settings > Office — PDF group description */
	settingsOfficePdfDescription: "Filling in and signing PDFs, synced across your devices",
	/** Settings > Office — PDF row label: how PDFs are saved */
	settingsOfficePdfSaving: "Saving",
	/** Settings > Office — PDF saving note (exact wording) */
	settingsOfficePdfSavingNote: "PDFs are never saved automatically. Use Save.",
	/** Settings > Office — row label: the visual signatures and initials saved in Fill & Sign */
	settingsOfficeSavedSignatures: "Saved signatures",
	/** Settings > Office — saved signatures row description */
	settingsOfficeSavedSignaturesDescription: "Signatures and initials you saved for reuse when signing PDFs.",
	/** Settings > Office — saved signatures row value when there are none */
	settingsOfficeSavedSignaturesNone: "None",
	/** Settings > Office — saved signatures row value: how many are saved */
	settingsOfficeSavedSignaturesCount_one: "{{count}} saved",
	/** Settings > Office — saved signatures row value: how many are saved */
	settingsOfficeSavedSignaturesCount_other: "{{count}} saved",
	/** Settings > Office — button opening the saved signatures dialog */
	settingsOfficeSavedSignaturesManage: "Manage",
	/** Settings > Office — accessible name of that button; starts with its visible word (settingsOfficeSavedSignaturesManage) */
	settingsOfficeSavedSignaturesManageLabel: "Manage saved signatures",
	/** Settings > Office — saved signatures dialog title */
	settingsOfficeSavedSignaturesDialogTitle: "Saved signatures",
	/** Settings > Office — saved signatures dialog description */
	settingsOfficeSavedSignaturesDialogDescription: "Deleting one removes it from every device. PDFs already signed with it don't change.",
	/** Settings > Office — saved signatures dialog: heading of the signatures list */
	settingsOfficeSavedSignaturesSignatures: "Signatures",
	/** Settings > Office — saved signatures dialog: heading of the initials list */
	settingsOfficeSavedSignaturesInitials: "Initials",
	/** Settings > Office — saved signatures dialog: a list without entries */
	settingsOfficeSavedSignaturesEmpty: "None saved",
	/** Settings > Office — saved signatures dialog: accessible name of the delete button of one entry. {{index}} counts from 1 */
	settingsOfficeSavedSignaturesDelete: "Delete signature {{index}}",
	/** Settings > Office — saved signatures dialog: accessible name of the delete button of one set of initials. {{index}} counts from 1 */
	settingsOfficeSavedInitialsDelete: "Delete initials {{index}}",
	/** Settings > Office — title of the question before a saved signature is deleted */
	settingsOfficeSavedSignaturesDeleteTitle: "Delete this signature?",
	/** Settings > Office — title of the question before saved initials are deleted */
	settingsOfficeSavedInitialsDeleteTitle: "Delete these initials?",
	/** Settings > Office — button confirming the delete of a saved signature or initials */
	settingsOfficeSavedSignaturesDeleteConfirm: "Delete",
	/** Settings > Office — toast when deleting a saved signature failed */
	settingsOfficeSavedSignaturesDeleteFailed: "The saved signature couldn't be deleted."
} as const
