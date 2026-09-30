/**
 * Key-identity translator for @/lib/i18n, exposing both the named `t` and `default.t` shapes.
 *
 *   vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))
 */
export const t = (key: string) => key

export default { t }
