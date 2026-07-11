import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

// Injected collaborators, same shape as changeEmail.logic.ts's runChangeEmailAttempt — testable
// without a worker or a React render. Both the versioning and login-alerts toggles share this exact
// round-trip: neither is optimistic (queries/client.ts's "confirm-then-patch" convention — call the
// SDK first, patch the query on success), so a failed mutation leaves the switch reading whatever
// `refetch` resolves to (the pre-toggle server value), never a value this module invented locally.
export interface PreferenceToggleDeps {
	setEnabled: (enabled: boolean) => Promise<void>
	refetch: () => Promise<unknown>
}

export type PreferenceToggleOutcome = { status: "success" } | { status: "error"; dto: ErrorDTO }

export async function runPreferenceToggle(deps: PreferenceToggleDeps, next: boolean): Promise<PreferenceToggleOutcome> {
	try {
		await deps.setEnabled(next)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	await deps.refetch()

	return { status: "success" }
}
