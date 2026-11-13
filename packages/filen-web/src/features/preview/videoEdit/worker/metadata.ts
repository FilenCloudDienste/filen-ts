import type { MetadataTags } from "mediabunny"

// The descriptive tags an edited video keeps from its original: the normalised fields, the creation time (the drive's
// when the file names none, never "now"), and the raw text tags (QuickTime keys such as the camera's make and model).
// Cover images are kept. With `removeLocation`, every location tag goes.

// QuickTime's user-data location (ISO 6709) and the mdta location keys Apple and Android write.
export function isLocationTag(key: string): boolean {
	const lower = key.toLowerCase()

	return lower === "©xyz" || lower.startsWith("com.apple.quicktime.location") || lower.startsWith("com.android.location")
}

export function editedTags(source: MetadataTags, options: { removeLocation: boolean; fallbackCreationTime: number | null }): MetadataTags {
	const raw: NonNullable<MetadataTags["raw"]> = {}

	for (const [key, value] of Object.entries(source.raw ?? {})) {
		// Only text survives: binary user-data atoms are written back by their own writers or not at all.
		if (typeof value === "string" && !(options.removeLocation && isLocationTag(key))) {
			raw[key] = value
		}
	}

	const creationTime = source.creationTime ?? (options.fallbackCreationTime === null ? null : new Date(options.fallbackCreationTime))
	const tags: MetadataTags = { raw, creationTime }

	if (source.title !== undefined) tags.title = source.title
	if (source.description !== undefined) tags.description = source.description
	if (source.artist !== undefined) tags.artist = source.artist
	if (source.album !== undefined) tags.album = source.album
	if (source.comment !== undefined) tags.comment = source.comment
	if (source.genre !== undefined) tags.genre = source.genre
	if (source.date !== undefined) tags.date = source.date
	if (source.images !== undefined) tags.images = source.images

	return tags
}
