// Browser-only download primitive shared by every security-settings export flow (master keys,
// the one-time 2FA recovery key): a plain-text Blob behind a throwaway object URL, clicked via a
// detached anchor and revoked immediately after — nothing here is Filen-specific, and
// `@filen/utils` ships no DOM helpers (checked first: it is deliberately runtime-agnostic and this
// touches `document`/`Blob`/`URL`, none of which exist under Node or React Native), so it stays
// local. Not unit-tested: this project's vitest config runs `environment: "node"` (no DOM — see
// vitest.config.ts), so `document`/`URL.createObjectURL` do not exist there; verified instead by
// the injected-session render check.
export function downloadTextFile(filename: string, content: string): void {
	const blob = new Blob([content], { type: "text/plain" })
	const url = URL.createObjectURL(blob)
	try {
		const anchor = document.createElement("a")
		anchor.href = url
		anchor.download = filename
		anchor.click()
	} finally {
		URL.revokeObjectURL(url)
	}
}
