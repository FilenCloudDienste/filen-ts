// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@/lib/i18n"
import type { ChartInfo, SheetChartEdit } from "@filen/office/react/sheet/charts"
import { ChartPanel } from "@/features/spreadsheet/charts/chartPanel"
import {
	axisKey,
	groupingOptions,
	labelPositionOptions,
	numberField,
	selectionReference
} from "@/features/spreadsheet/charts/chartPanel.logic"

// The chart editor panel: what it offers for the chart it shows, and the one edit each change sends (text fields on
// Enter or blur); a chart the editor cannot change shows read-only; Escape closes it.

afterEach(() => {
	cleanup()
})

const INFO: ChartInfo = {
	title: "Fruit",
	legend: "r",
	plots: [
		{
			index: 0,
			element: "barChart",
			type: "column",
			grouping: "clustered",
			threeD: false,
			axes: [111, 222],
			labels: null,
			series: [
				{
					index: 0,
					idx: 0,
					order: 0,
					name: "Sold",
					nameRef: "Data!$B$1",
					categories: "Data!$A$2:$A$4",
					values: "Data!$B$2:$B$4",
					labels: null
				},
				{ index: 1, idx: 1, order: 1, name: "Kept", nameRef: null, categories: null, values: "Data!$C$2:$C$4", labels: null }
			]
		}
	],
	axes: [
		{
			id: 111,
			kind: "cat",
			position: "b",
			visible: true,
			min: null,
			max: null,
			major: null,
			minor: null,
			logBase: null,
			reversed: false,
			format: null,
			title: null,
			majorGridlines: false
		},
		{
			id: 222,
			kind: "val",
			position: "l",
			visible: true,
			min: 0,
			max: null,
			major: null,
			minor: null,
			logBase: null,
			reversed: false,
			format: null,
			title: "Count",
			majorGridlines: true
		}
	]
}

function panel(readOnly = false, info: ChartInfo = INFO) {
	const edits: SheetChartEdit[] = []
	const onClose = vi.fn()

	render(
		<ChartPanel
			sheet={1}
			part="xl/charts/chart1.xml"
			state={{ status: "ready", info, readOnly }}
			canEdit
			selection={{ startRow: 1, startCol: 3, endRow: 3, endCol: 3 }}
			onEdit={edit => {
				edits.push(edit)
			}}
			onClose={onClose}
		/>
	)

	return { edits, onClose }
}

describe("chart editor panel", () => {
	it("applies a text field on Enter, once, and not when it did not change", () => {
		const { edits } = panel()
		const title = screen.getByLabelText("Chart title")

		fireEvent.change(title, { target: { value: "Fruit sold" } })
		fireEvent.keyDown(title, { key: "Enter" })
		fireEvent.blur(title)
		expect(edits).toEqual([{ kind: "title", text: "Fruit sold" }])

		const name = screen.getAllByLabelText("Name")[1]

		if (name === undefined) throw new Error("no name field")

		fireEvent.blur(name)
		expect(edits.length).toBe(1)
	})

	it("sends series edits naming each series by its id: a range, a move, a removal and a series of the selection", () => {
		const { edits } = panel()
		const values = screen.getAllByLabelText("Values")[0]

		if (values === undefined) throw new Error("no values field")

		fireEvent.change(values, { target: { value: "B2:B9" } })
		fireEvent.blur(values)
		fireEvent.click(within(screen.getByRole("group", { name: "Sold" })).getByRole("button", { name: "Move series down" }))
		// Clicked twice before the chart is read again: the series is removed once.
		fireEvent.click(within(screen.getByRole("group", { name: "Kept" })).getByRole("button", { name: "Remove series" }))
		fireEvent.click(within(screen.getByRole("group", { name: "Kept" })).getByRole("button", { name: "Remove series" }))
		fireEvent.click(screen.getByRole("button", { name: "Add series from selection" }))
		expect(edits).toEqual([
			{ kind: "series.set", series: 0, id: 0, values: "B2:B9" },
			{ kind: "series.move", series: 0, id: 0, to: 1 },
			{ kind: "series.remove", series: 1, id: 1 },
			{ kind: "series.add", plot: 0, name: null, categories: null, values: "D2:D4" }
		])
		// The first series can move no earlier.
		expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "Move series up" })[0]?.disabled).toBe(true)
	})

	it("sends axis bounds, an empty bound as automatic, and gridlines", () => {
		const { edits } = panel()
		const minimum = screen.getByLabelText("Minimum")

		fireEvent.change(minimum, { target: { value: "" } })
		fireEvent.blur(minimum)
		fireEvent.change(screen.getByLabelText("Maximum"), { target: { value: "12.5" } })
		fireEvent.blur(screen.getByLabelText("Maximum"))
		expect(edits).toEqual([
			{ kind: "axis", axis: 222, patch: { min: null } },
			{ kind: "axis", axis: 222, patch: { max: 12.5 } }
		])
	})

	it("names each series' group by the series, so its controls say whose they are", () => {
		panel()

		const sold = screen.getByRole("group", { name: "Sold" })
		const kept = screen.getByRole("group", { name: "Kept" })

		expect(within(sold).getByRole("button", { name: "Remove series" })).toBeTruthy()
		expect(within(kept).getByLabelText<HTMLInputElement>("Values").value).toBe("Data!$C$2:$C$4")
		// The axes and the data labels are named groups too.
		expect(screen.getByRole("group", { name: "Vertical axis" })).toBeTruthy()
		expect(screen.getByRole("group", { name: "Data labels" })).toBeTruthy()
	})

	it("shows a chart the editor cannot change read-only", () => {
		panel(true)

		expect(screen.getByText(/can't be changed here/)).toBeTruthy()
		expect(screen.getByLabelText<HTMLInputElement>("Chart title").disabled).toBe(true)
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add series from selection" }).disabled).toBe(true)
	})

	it("names the type of a plot it cannot change in one line", () => {
		const [plot] = INFO.plots

		if (plot === undefined) throw new Error("no plot")

		panel(false, { ...INFO, plots: [{ ...plot, type: "radar", element: "radarChart" }] })

		expect(screen.getByText("Chart type: Radar")).toBeTruthy()
	})

	it("takes focus when it opens, at its heading", () => {
		panel()

		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Chart" }))
	})

	it("keeps focus in the panel when the series whose button had it is removed", () => {
		const props = {
			sheet: 1,
			part: "xl/charts/chart1.xml",
			canEdit: true,
			selection: undefined,
			onEdit: () => undefined,
			onClose: () => undefined
		}
		const view = render(
			<ChartPanel
				{...props}
				state={{ status: "ready", info: INFO, readOnly: false }}
			/>
		)
		const remove = within(screen.getByRole("group", { name: "Sold" })).getByRole("button", { name: "Remove series" })

		remove.focus()

		const plot = INFO.plots[0]

		if (plot === undefined) throw new Error("no plot")

		const kept = { ...plot, series: plot.series.slice(1).map(entry => ({ ...entry, index: 0 })) }

		view.rerender(
			<ChartPanel
				{...props}
				state={{ status: "ready", info: { ...INFO, plots: [kept] }, readOnly: false }}
			/>
		)
		expect(screen.queryByRole("group", { name: "Sold" })).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Chart" }))
	})

	it("closes on Escape and with its close button", () => {
		const { onClose } = panel()

		fireEvent.keyDown(screen.getByRole("complementary", { name: "Chart" }), { key: "Escape" })
		fireEvent.click(screen.getByRole("button", { name: "Close chart editor" }))
		expect(onClose).toHaveBeenCalledTimes(2)
	})
})

describe("chart editor choices", () => {
	it("offers the layouts and label positions each type allows", () => {
		expect(groupingOptions("bar").map(option => option.value)).toEqual(["clustered", "stacked", "percentStacked"])
		expect(groupingOptions("pie")).toEqual([])
		expect(labelPositionOptions(INFO.plots).map(option => option.value)).toEqual(["default", "ctr", "inEnd", "inBase", "outEnd"])
		// A line and a column together: only what both allow.
		expect(
			labelPositionOptions([
				...INFO.plots,
				{ ...INFO.plots[0], type: "line", grouping: "standard" } as ChartInfo["plots"][number]
			]).map(option => option.value)
		).toEqual(["default", "ctr"])
	})

	it("names axes by where they sit and reads number fields", () => {
		expect(INFO.axes.map(axis => axisKey(axis, INFO.axes))).toEqual([
			"previewSheetChartAxisHorizontal",
			"previewSheetChartAxisVertical"
		])
		expect(numberField(" 2.5 ")).toBe(2.5)
		expect(numberField("")).toBeNull()
		expect(numberField("ten")).toBeUndefined()
		expect(selectionReference({ startRow: 0, startCol: 0, endRow: 4, endCol: 1 })).toBe("A1:B5")
	})
})
