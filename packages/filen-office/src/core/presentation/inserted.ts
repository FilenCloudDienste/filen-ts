// The name a picture or a medium an op inserted carries until a save gives it a part: "inserted:<registry id>". Image
// ids and media ids are separate number spaces behind the one prefix: insertedMediaId (edit/apply/media.ts) and the
// image lookups (edit/apply/picture.ts) say which registry a name means.
export const INSERTED_PREFIX = "inserted:"

export function insertedPartName(id: number): string {
	return `${INSERTED_PREFIX}${String(id)}`
}

// The registry id a pending name carries (not checked: NaN when the rest is not a number), else undefined.
export function insertedPartId(part: string): number | undefined {
	return part.startsWith(INSERTED_PREFIX) ? Number(part.slice(INSERTED_PREFIX.length)) : undefined
}
