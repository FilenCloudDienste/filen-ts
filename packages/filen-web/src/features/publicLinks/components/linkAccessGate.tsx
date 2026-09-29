import { type LinkAccessState } from "@/features/publicLinks/lib/password.logic"
import { PasswordGate } from "@/features/publicLinks/components/passwordGate"
import { PublicLinkLoading, PublicLinkInvalid, PublicLinkError } from "@/features/publicLinks/components/publicLinkStates"

// The surface for every not-yet-ready access state, shared by both link kinds. Kept apart from
// publicLinkStates because PasswordGate imports CenteredSurface from there.
export function LinkAccessGate({
	access,
	onRetry,
	onSubmitPassword
}: {
	access: Exclude<LinkAccessState, "ready">
	onRetry: () => void
	onSubmitPassword: (password: string) => void
}) {
	switch (access) {
		case "loading":
			return <PublicLinkLoading />
		case "invalid":
			return <PublicLinkInvalid />
		case "error":
			return <PublicLinkError onRetry={onRetry} />
		default:
			return (
				<PasswordGate
					state={access}
					onSubmit={onSubmitPassword}
				/>
			)
	}
}
