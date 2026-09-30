/**
 * Key-identity useTranslation for react-i18next.
 *
 *   vi.mock("react-i18next", async () => await import("@/tests/mocks/reactI18next"))
 */
export const useTranslation = () => ({ t: (key: string) => key })
