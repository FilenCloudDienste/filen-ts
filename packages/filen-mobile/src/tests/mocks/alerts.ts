/**
 * Shared mock of @/lib/alerts for Vitest.
 *
 * Usage in test files:
 *
 *   vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
 */

import { vi } from "vitest"

export default {
	error: vi.fn()
}
