// "preview" namespace, PowerPoint 97–2003 decks (.ppt, .pps, .pot): what the viewer says about a deck in the legacy
// binary format, which opens to be looked at only. Spread into preview.ts; same catalog rules.
export const previewPptxLegacy = {
	/** Presentation viewer — note over a PowerPoint 97–2003 deck (.ppt, .pps, .pot): it is shown, not edited */
	previewPptxLegacyViewOnly: "PowerPoint 97–2003 presentation. It can be viewed but not edited here.",
	/** Presentation viewer — accessible name of the note about the legacy PowerPoint 97–2003 format */
	previewPptxLegacyLabel: "Legacy format"
} as const
