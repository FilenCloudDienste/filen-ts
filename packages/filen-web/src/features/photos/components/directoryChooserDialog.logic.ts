// What "Choose this directory" picks: the directory open in the picker, or at the top the whole drive,
// chosen by its root uuid — null until the account that names the root is loaded, so confirm stays
// disabled rather than saving an empty root.
export function photosChooserChoice(targetUuid: string | null, driveRootUuid: string | undefined): string | null {
	if (targetUuid !== null) {
		return targetUuid
	}

	return driveRootUuid !== undefined && driveRootUuid.length > 0 ? driveRootUuid : null
}
