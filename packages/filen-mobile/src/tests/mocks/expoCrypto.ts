/**
 * In-memory mock of expo-crypto for Vitest.
 *
 * Usage in test files:
 *
 *   vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
 */

let counter = 0

export function randomUUID(): string {
	return `mock-uuid-${counter++}`
}

/** Reset the UUID counter between tests if deterministic IDs are needed. */
export function resetUUIDCounter(): void {
	counter = 0
}
