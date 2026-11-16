// What a MetadataCard shows, as plain structured-cloneable data: workers build it from the file and post it as is.

export interface MetadataField {
	readonly label: string
	readonly value: string
	// Identifiers, hashes and offsets: a monospaced face, broken anywhere.
	readonly mono?: boolean
	// The text a Copy button beside the value copies; no button without it.
	readonly copy?: string
}

export interface MetadataSectionData {
	readonly title?: string
	readonly fields: readonly MetadataField[]
}

export interface MetadataTableColumn {
	readonly key: string
	readonly label: string
	readonly align?: "start" | "end"
}

export interface MetadataTableData {
	readonly label: string
	readonly columns: readonly MetadataTableColumn[]
	// One string per column, in column order.
	readonly rows: readonly (readonly string[])[]
}
