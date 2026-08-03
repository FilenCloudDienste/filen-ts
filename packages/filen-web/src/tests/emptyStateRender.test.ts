// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { EmptyState } from "@/features/drive/components/emptyState"
import { type ErrorDTO } from "@/lib/sdk/errors"

// emptyState.test.ts (node env) covers driveEmptyStateCopy; a vitest environment directive is
// per-file, so the rendered-DOM assertions need their own.
const ERROR: ErrorDTO = { species: "plain", label: "Error", message: "listing exploded" }

afterEach(() => {
	cleanup()
})

describe("EmptyState", () => {
	it("announces the error variant assertively, with the failure label and the retry action inside it", () => {
		const { getByRole } = render(
			createElement(EmptyState, {
				variant: "error",
				error: ERROR,
				onRetry: () => {
					// no-op — the announcement, not the retry flow, is under test
				}
			})
		)

		const alert = getByRole("alert")

		expect(alert.textContent).toContain("Couldn't load this directory")
		expect(alert.textContent).toContain("Try again")
	})

	it("stays silent on the empty variant — an empty directory is not an error", () => {
		const { queryByRole } = render(createElement(EmptyState, { variant: "empty", driveVariant: "drive" }))

		expect(queryByRole("alert")).toBeNull()
	})

	it("keeps the two testids the listing helpers settle on", () => {
		const empty = render(createElement(EmptyState, { variant: "empty", driveVariant: "drive" }))

		expect(empty.container.querySelector('[data-testid="listing-empty"]')).not.toBeNull()

		cleanup()

		const errored = render(
			createElement(EmptyState, {
				variant: "error",
				error: ERROR,
				onRetry: () => {
					// no-op
				}
			})
		)

		expect(errored.container.querySelector('[data-testid="listing-error"]')).not.toBeNull()
	})
})
