import { PresentationError, refused, type PresentationRefusal, type Refused } from "./model"

// Refusal helpers over the model's PresentationRefusal: what readers throw while reading (caught once at the
// reader's entry and answered as a value) and the mapping of other layers' reasons onto ours.

export function isRefused(value: unknown): value is Refused {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "refused"
}

// A budget exceeded: thrown where it is found, before the allocation it guards.
export function tooLarge(what: string, limit: number): never {
	throw new PresentationError("tooLarge", `${what} over ${String(limit)}`)
}

export function tooDeep(what: string, limit: number): never {
	throw new PresentationError("tooDeep", `${what} deeper than ${String(limit)}`)
}

// Runs a reader, answering a thrown PresentationError as its refusal; anything else propagates.
export async function guarded<T>(read: () => Promise<T>): Promise<T | Refused> {
	try {
		return await read()
	} catch (error) {
		if (error instanceof PresentationError) return refused(error.reason, error.message)

		throw error
	}
}

// The encrypted-package layer's reasons (dom/encryption's EncryptionRefusal and unlock failures).
export function encryptionRefusal(reason: "rightsManaged" | "unsupported" | "damaged" | "wrongPassword" | "aborted"): PresentationRefusal {
	switch (reason) {
		case "rightsManaged":
			return "rightsManaged"
		case "unsupported":
			return "unsupportedEncryption"
		case "damaged":
			return "damagedEncryption"
		case "wrongPassword":
			return "wrongPassword"
		case "aborted":
			return "aborted"
	}
}
