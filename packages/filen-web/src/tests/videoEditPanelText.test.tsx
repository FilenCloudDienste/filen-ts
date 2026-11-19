// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { VideoEditPanel } from "@/features/preview/videoEdit/components/videoEditPanel"
import type { TextOverlay } from "@/features/preview/videoEdit/types"
import { recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"

// The Text tab's chips: a box whose text was cleared still has a name.

const noop = vi.fn()

function box(id: string, text: string): TextOverlay {
	return { id, text, startSec: 0, endSec: 1, x: 0.5, y: 0.5, size: 0.1, color: "#fff", background: false }
}

describe("VideoEditPanel text chips", () => {
	it("names a blank box and keeps the text of the others", () => {
		render(
			<VideoEditPanel
				idBase="panel"
				tab="text"
				recipe={recipeFor(60, { text: [box("a", "  "), box("b", "Hello")] })}
				info={sourceInfo()}
				unavailable={new Set()}
				hdrNote={false}
				selection={null}
				aspect="free"
				selectedText={null}
				thumbnails={null}
				onTab={noop}
				onChange={noop}
				onTrim={noop}
				onSelection={noop}
				onRemoveSelection={noop}
				onRestore={noop}
				onAspect={noop}
				onTurn={noop}
				onFlip={noop}
				onResetCrop={noop}
				onAddText={noop}
				onSelectText={noop}
			/>
		)

		expect(screen.getByRole("button", { name: "Empty text" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Hello" })).toBeTruthy()
	})
})
