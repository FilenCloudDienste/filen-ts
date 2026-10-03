// An archive job's password, held only here while its job exists: never in a store, a transfers row, a
// toast or a log. A rerun with a new password replaces it; pruning the job forgets it. The SDK refuses an
// empty password, so one counts as none.
const passwords = new Map<string, string>()

export function holdJobPassword(id: string, password: string | undefined): void {
	if (password === undefined || password === "") {
		passwords.delete(id)

		return
	}

	passwords.set(id, password)
}

export function jobPassword(id: string): string | undefined {
	return passwords.get(id)
}

export function forgetJobPassword(id: string): void {
	passwords.delete(id)
}
