// Drive feature vocabulary (src/lib/drive.ts — the public-link password prompts in
// `openLinkedDirectory` / `openLinkedFile`). Shared keys live in common.ts (cancel, submit) and
// the wrong-password message is reused from errors.ts (`wrong_password`) — none are redefined here.
export const drive = {
	/** Public-link password prompt — dialog title shown when a protected link needs a password */
	password_required: "Password required",
	/** Public-link password prompt — dialog message asking for a protected directory link's password */
	enter_public_link_directory_password: "Enter the password for this directory link",
	/** Public-link password prompt — dialog message asking for a protected file link's password */
	enter_public_link_file_password: "Enter the password for this file link"
} as const
