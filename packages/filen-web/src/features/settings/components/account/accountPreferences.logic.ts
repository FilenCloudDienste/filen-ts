import { asErrorDTO } from "@/lib/sdk/errors"
import { type VoidActionOutcome } from "@/lib/actions/outcome"

// Injected collaborators, same shape as changeEmail.logic.ts's runChangeEmailAttempt — testable
// without a worker or a React render. Both the versioning and login-alerts toggles share this exact
// round-trip: neither is optimistic (queries/client.ts's "confirm-then-patch" convention — call the
// SDK first, patch the query on success), so a failed mutation leaves the switch on the pre-toggle
// server value, never a value this module invented locally. The toggled flag is the write's whole
// effect, so `patch` sets it in the cached account instead of reading the account back.
export interface PreferenceToggleDeps {
	setEnabled: (enabled: boolean) => Promise<void>
	patch: (enabled: boolean) => void
}

export async function runPreferenceToggle(deps: PreferenceToggleDeps, next: boolean): Promise<VoidActionOutcome> {
	try {
		await deps.setEnabled(next)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	deps.patch(next)

	return { status: "success" }
}
