/**
 * The slice of @filen/sdk-rs the real src/lib/sdkErrors.ts classifiers touch, so they run end-to-end
 * instead of a stubbed verdict. By default no value is an SDK error (hasInner → false); asSdkError
 * marks a thrown value as a FilenSdkError of a chosen kind. Clear sdkErrorState.innerOf in beforeEach.
 *
 * Usage:
 *   vi.mock("@filen/sdk-rs", async () => {
 *     const m = await import("@/tests/mocks/sdkErrors")
 *     return { ErrorKind: m.ErrorKind, FilenSdkError: m.FilenSdkError }
 *   })
 */

// Member names mirror @filen/sdk-rs. The values are names, not numbers: kind() returns them and the
// same object backs the classifier's ErrorKind[kind()] lookup, which then yields the name.
export const ErrorKind = {
	Server: "Server",
	Unauthenticated: "Unauthenticated",
	Reqwest: "Reqwest",
	RetryFailed: "RetryFailed",
	Response: "Response"
} as const

export const sdkErrorState = {
	innerOf: new Map<unknown, { kind: () => string; message: () => string }>()
}

export class FilenSdkError {
	public static hasInner(error: unknown): boolean {
		return sdkErrorState.innerOf.has(error)
	}

	public static getInner(error: unknown): unknown {
		return sdkErrorState.innerOf.get(error)
	}
}

export function asSdkError<E>(error: E, kind: string): E {
	sdkErrorState.innerOf.set(error, {
		kind: () => kind,
		message: () => `mock ${kind}`
	})

	return error
}
