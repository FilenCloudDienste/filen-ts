// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

type HeaderButton = { props: { onPress: () => Promise<void> } }
type GroupButton = { title: string; onPress: () => Promise<void> | void }

const captured = vi.hoisted(() => ({
	rightItems: null as null | (() => HeaderButton[] | null),
	buttons: [] as GroupButton[],
	params: {} as { personal?: string }
}))

const mocks = vi.hoisted(() => ({
	updatePersonalInfo: vi.fn(async () => {}),
	accountQueryPatch: vi.fn(),
	inputPrompt: vi.fn(async (): Promise<string | null> => null)
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@filen/shared", async () => ({ ...(await import("@/tests/mocks/filenShared")), COUNTRIES: [] }))
vi.mock("react-i18next", async () => await import("@/tests/mocks/reactI18next"))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@/components/ui/fullScreenLoadingModal", async () => await import("@/tests/mocks/fullScreenLoadingModal"))
vi.mock("@/components/ui/safeAreaView", () => ({ ScreenBody: ({ children }: { children: unknown }) => children }))
vi.mock("@/components/ui/settingsScrollView", () => ({ SettingsScrollView: ({ children }: { children: unknown }) => children }))
vi.mock("@/components/ui/settingsGroup", () => ({
	Group: ({ buttons }: { buttons: GroupButton[] }) => {
		captured.buttons = buttons

		return null
	}
}))
vi.mock("@/components/ui/settingsHeader", () => ({
	default: ({ rightItems }: { rightItems: () => HeaderButton[] | null }) => {
		captured.rightItems = rightItems

		return null
	}
}))
vi.mock("@/components/dismissStack", () => ({ default: () => null }))
vi.mock("expo-router", () => ({ useLocalSearchParams: () => captured.params }))
vi.mock("@/lib/router", () => ({ goBackIfPossible: vi.fn() }))
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "blue" }) }))
vi.mock("@/queries/useAccount.query", () => ({ accountQueryPatch: mocks.accountQueryPatch }))
vi.mock("@/lib/promptFlow", () => ({ inputPrompt: mocks.inputPrompt }))
vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: async () => ({ authedSdkClient: { updatePersonalInfo: mocks.updatePersonalInfo } }) }
}))
vi.mock("@/lib/serializer", () => ({
	deserializeRouteParam: (serialized: string | undefined) => (serialized ? JSON.parse(serialized) : null)
}))
vi.mock("@/providers/actionSheet.provider", () => ({ actionSheet: { show: vi.fn() } }))
vi.mock("@/hooks/useIsOnline", () => ({ default: () => true }))

import Personal from "@/features/settings/screens/personal"

const seed = {
	firstName: "Ada",
	lastName: null,
	companyName: null,
	vatId: null,
	street: null,
	streetNumber: null,
	city: null,
	postalCode: null,
	country: null
}

async function editCompanyAndSave(): Promise<void> {
	mocks.inputPrompt.mockResolvedValueOnce("Acme")

	const company = captured.buttons.find(button => button.title === "company_name")

	await act(async () => {
		await company?.onPress()
	})

	const save = captured.rightItems?.()?.[0]

	await act(async () => {
		await save?.props.onPress()
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	captured.params = { personal: JSON.stringify(seed) }
	captured.rightItems = null
	captured.buttons = []
})

afterEach(() => {
	cleanup()
})

describe("Personal save", () => {
	it("patches the account cache with exactly the object the server accepted", async () => {
		render(<Personal />)

		await editCompanyAndSave()

		const saved = { ...seed, companyName: "Acme" }

		expect(mocks.updatePersonalInfo).toHaveBeenCalledWith(saved)
		expect(mocks.accountQueryPatch).toHaveBeenCalledTimes(1)
		expect(mocks.accountQueryPatch).toHaveBeenCalledWith({ personal: saved })
	})

	it("leaves the cache alone when the save fails", async () => {
		mocks.updatePersonalInfo.mockRejectedValueOnce(new Error("offline"))

		render(<Personal />)

		await editCompanyAndSave()

		expect(mocks.updatePersonalInfo).toHaveBeenCalledTimes(1)
		expect(mocks.accountQueryPatch).not.toHaveBeenCalled()
	})
})
