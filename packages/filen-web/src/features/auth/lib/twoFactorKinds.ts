import type { SdkErrorKind } from "@/lib/sdk/errorKinds.gen"

// `satisfies` pins these to the generated kind union: an SDK rename fails compilation here instead
// of silently breaking the two-factor branches at runtime. Shared by the login attempt (where a
// retry is safe) and the reset attempt (where it is not — see resetAttempt.ts).
const TWO_FACTOR_KINDS: readonly string[] = ["Enter2fa", "Wrong2fa"] satisfies readonly SdkErrorKind[]
const WRONG_2FA = "Wrong2fa" satisfies SdkErrorKind

// `null` = not a two-factor rejection. `wrongCode` distinguishes a rejected code (Wrong2fa, only ever
// returned for an attempt that DID send one) from the code-less first attempt (Enter2fa).
export function readTwoFactorKind(kind: string | undefined): { wrongCode: boolean } | null {
	if (kind === undefined || !TWO_FACTOR_KINDS.includes(kind)) {
		return null
	}

	return { wrongCode: kind === WRONG_2FA }
}
