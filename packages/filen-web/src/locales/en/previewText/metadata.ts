// "preview" namespace, text family — the metadata card shared by the file-facts views (torrent, executable, calendar,
// contact, e-book properties, rich-viewer side panels). Spread into preview.ts; same catalog rules.
export const previewTextMetadata = {
	/** Metadata card — accessible name and tooltip of the button copying one field's value; {{field}} is the field's label (e.g. "Infohash") */
	previewMetadataCopy: "Copy {{field}}",
	/** Metadata card — toast after a field's value was copied to the clipboard */
	previewMetadataCopied: "Copied"
} as const
