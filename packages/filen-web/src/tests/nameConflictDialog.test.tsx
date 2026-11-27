// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import "@/lib/i18n"
import { NameConflictPrompt } from "@/features/drive/components/nameConflictDialog"
import type { NameConflictAsk } from "@/features/drive/lib/nameConflictAsk"
import type { ConflictAnswer, ConflictOperation, NameConflict } from "@/features/drive/lib/nameConflicts"

afterEach(() => {
	cleanup()
})

function ask(conflicts: NameConflict[], options: { operation?: ConflictOperation; versioning?: boolean } = {}) {
	const settle = vi.fn<(answer: ConflictAnswer | null) => void>()
	const value: NameConflictAsk = {
		id: "ask",
		operation: options.operation ?? "upload",
		destination: "Docs",
		conflicts,
		versioning: options.versioning ?? true,
		settle
	}

	return { value, settle }
}

const FILE: NameConflict = { index: 0, name: "a.txt", isDirectory: false, existing: "file" }
const DIRECTORY: NameConflict = { index: 1, name: "Photos", isDirectory: true, existing: "directory" }
const FILE_ON_DIRECTORY: NameConflict = { index: 2, name: "b", isDirectory: false, existing: "directory" }

describe("NameConflictPrompt", () => {
	it("offers Replace for one file, saying the previous version is kept", () => {
		const { value, settle } = ask([FILE])

		render(<NameConflictPrompt ask={value} />)

		expect(screen.getByText("“a.txt” already exists in Docs")).toBeTruthy()
		expect(screen.getByText(/keeps the existing file as a previous version in Versions/)).toBeTruthy()
		expect(screen.queryByRole("checkbox")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Replace" }))

		expect(settle).toHaveBeenCalledExactlyOnceWith({ choices: ["replace"], nested: "replace" })
	})

	it("warns that Replace overwrites when versioning is off", () => {
		render(<NameConflictPrompt ask={ask([FILE], { versioning: false }).value} />)

		expect(screen.getByText(/no previous version is kept/)).toBeTruthy()
	})

	it("asks one clash at a time, Merge carrying its policy for the files inside", () => {
		const { value, settle } = ask([FILE, DIRECTORY, FILE_ON_DIRECTORY])

		render(<NameConflictPrompt ask={value} />)

		expect(screen.getByText("3 items already exist in Docs")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Keep both" }))

		expect(screen.getByText(/“Photos” \(2 of 3\)/)).toBeTruthy()
		fireEvent.click(screen.getByRole("radio", { name: "Skip them" }))
		fireEvent.click(screen.getByRole("button", { name: "Merge" }))

		// A file onto a directory has no Replace.
		expect(screen.queryByRole("button", { name: "Replace" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Skip" }))

		expect(settle).toHaveBeenCalledExactlyOnceWith({ choices: ["keepBoth", "merge", "skip"], nested: "skip" })
	})

	it("applies one choice to every remaining clash as each allows it", () => {
		const { value, settle } = ask([FILE, DIRECTORY, FILE_ON_DIRECTORY])

		render(<NameConflictPrompt ask={value} />)

		fireEvent.click(screen.getByRole("checkbox", { name: "Do this for all 3 remaining conflicts" }))
		fireEvent.click(screen.getByRole("button", { name: "Replace" }))

		expect(settle).toHaveBeenCalledExactlyOnceWith({ choices: ["replace", "merge", "keepBoth"], nested: "replace" })
	})

	it("offers no Merge for a moved directory", () => {
		render(<NameConflictPrompt ask={ask([DIRECTORY], { operation: "move" }).value} />)

		expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
		expect(screen.getByRole("button", { name: "Keep both" })).toBeTruthy()
	})

	it("skips what is not decided yet when dismissed", () => {
		const { value, settle } = ask([FILE, DIRECTORY])

		render(<NameConflictPrompt ask={value} />)

		fireEvent.click(screen.getByRole("button", { name: "Replace" }))
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

		expect(settle).toHaveBeenCalledExactlyOnceWith({ choices: ["replace", "skip"], nested: "replace" })
	})
})
