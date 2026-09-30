/**
 * Pass-through useShallow for zustand/shallow.
 *
 *   vi.mock("zustand/shallow", async () => await import("@/tests/mocks/zustandShallow"))
 */
export function useShallow<T>(selector: T): T {
	return selector
}
