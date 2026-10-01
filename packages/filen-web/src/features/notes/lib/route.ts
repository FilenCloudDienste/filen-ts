// The URL owns the selected note: /notes/<uuid> is a selection key, not a path hierarchy. Read from the
// raw pathname, as the sidebar renders in the app shell (outside the notes route match). Empty at
// "/notes" (nothing selected).
export function selectedNoteUuidFromPath(pathname: string): string {
	const match = /^\/notes\/([^/]+)/.exec(pathname)

	return match?.[1] ?? ""
}
