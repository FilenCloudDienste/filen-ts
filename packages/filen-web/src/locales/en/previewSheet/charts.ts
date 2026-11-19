// "preview" namespace, spreadsheet viewer — charts: inserting one, and the chart editor's side
// panel. Spread into preview.ts; same catalog rules.
export const previewSheetCharts = {
	/** Spreadsheet Insert menu and grid menu — submenu of chart types to insert a chart of the selected cells */
	previewSheetChartInsert: "Chart",
	/** Spreadsheet grid menu — submenu of chart types (the grid's own menu says what it inserts) */
	previewSheetChartInsertMenu: "Insert chart",
	/** Spreadsheet grid menu, with a chart selected — opens the chart editor panel */
	previewSheetChartEdit: "Edit chart…",
	/** Chart types — vertical bars */
	previewSheetChartTypeColumn: "Column",
	/** Chart types — horizontal bars */
	previewSheetChartTypeBar: "Bar",
	/** Chart types — lines */
	previewSheetChartTypeLine: "Line",
	/** Chart types — filled areas */
	previewSheetChartTypeArea: "Area",
	/** Chart types — a pie */
	previewSheetChartTypePie: "Pie",
	/** Chart types — a ring */
	previewSheetChartTypeDoughnut: "Doughnut",
	/** Chart types — points at x and y values */
	previewSheetChartTypeScatter: "Scatter",
	/** Chart types — a radar chart, which the editor shows but cannot make */
	previewSheetChartTypeRadar: "Radar",
	/** Chart types — a kind the editor cannot change (stock, surface, bubble) */
	previewSheetChartTypeOther: "Other",
	/** Chart groupings — bars side by side */
	previewSheetChartGroupingClustered: "Clustered",
	/** Chart groupings — lines and areas each on their own values */
	previewSheetChartGroupingStandard: "Standard",
	/** Chart groupings — series stacked on each other */
	previewSheetChartGroupingStacked: "Stacked",
	/** Chart groupings — series stacked to 100% */
	previewSheetChartGroupingPercent: "100% stacked",
	/** Chart editor panel — its heading and accessible name */
	previewSheetChartPanel: "Chart",
	/** Chart editor panel — closes it */
	previewSheetChartPanelClose: "Close chart editor",
	/** Chart editor panel — shown while the chart is read */
	previewSheetChartLoading: "Reading the chart…",
	/** Chart editor panel — the chart holds what this editor cannot change without losing it */
	previewSheetChartReadOnly: "This chart uses features the editor doesn't support, so it can't be changed here. It stays as it is.",
	/** Chart editor panel — the chart is no longer there (deleted, or its sheet changed) */
	previewSheetChartGone: "This chart is no longer in the workbook.",
	/** Chart editor panel — section: chart type and grouping */
	previewSheetChartSectionType: "Type",
	/** Chart editor panel — section: series and the cells they read */
	previewSheetChartSectionData: "Data",
	/** Chart editor panel — section: axes */
	previewSheetChartSectionAxes: "Axes",
	/** Chart editor panel — section: chart title, legend and data labels */
	previewSheetChartSectionTitles: "Titles & legend",
	/** Chart editor panel — a group of series of one type in a combination chart, numbered */
	previewSheetChartPlot: "Series group {{number}}",
	/** Chart editor panel — chart type field */
	previewSheetChartType: "Chart type",
	/** Chart editor panel — the read-only type line of a chart whose type cannot be changed here; {{type}} is the type's name (e.g. "Radar") */
	previewSheetChartTypeReadOnly: "Chart type: {{type}}",
	/** Chart editor panel — grouping field */
	previewSheetChartGrouping: "Layout",
	/** Chart editor panel — a combination chart's groups take column, line or area only */
	previewSheetChartComboHint: "A combination chart's groups can be column, line or area charts.",
	/** Chart editor panel — a series, numbered, when it has no name */
	previewSheetChartSeries: "Series {{number}}",
	/** Chart editor panel — the series' name field (text, or "=" and a cell) */
	previewSheetChartSeriesName: "Name",
	/** Chart editor panel — the series' values field (a cell range) */
	previewSheetChartSeriesValues: "Values",
	/** Chart editor panel — the series' categories field (a cell range) */
	previewSheetChartSeriesCategories: "Categories",
	/** Chart editor panel — a scatter series' x values field */
	previewSheetChartSeriesX: "X values",
	/** Chart editor panel — a scatter series' y values field */
	previewSheetChartSeriesY: "Y values",
	/** Chart editor panel — hint under the range fields */
	previewSheetChartRangeHint: "A range such as Sheet1!A2:A10.",
	/** Chart editor panel — moves a series one place earlier */
	previewSheetChartSeriesUp: "Move series up",
	/** Chart editor panel — moves a series one place later */
	previewSheetChartSeriesDown: "Move series down",
	/** Chart editor panel — removes a series */
	previewSheetChartSeriesRemove: "Remove series",
	/** Chart editor panel — adds a series of the selected cells */
	previewSheetChartSeriesAdd: "Add series from selection",
	/** Chart editor panel — the horizontal axis */
	previewSheetChartAxisHorizontal: "Horizontal axis",
	/** Chart editor panel — the vertical axis */
	previewSheetChartAxisVertical: "Vertical axis",
	/** Chart editor panel — a second horizontal axis */
	previewSheetChartAxisHorizontal2: "Secondary horizontal axis",
	/** Chart editor panel — a second vertical axis */
	previewSheetChartAxisVertical2: "Secondary vertical axis",
	/** Chart editor panel — shows or hides an axis */
	previewSheetChartAxisShow: "Show axis",
	/** Chart editor panel — an axis's title field */
	previewSheetChartAxisTitle: "Axis title",
	/** Chart editor panel — the axis's lowest value; empty is automatic */
	previewSheetChartAxisMin: "Minimum",
	/** Chart editor panel — the axis's highest value; empty is automatic */
	previewSheetChartAxisMax: "Maximum",
	/** Chart editor panel — the step between the axis's labels; empty is automatic */
	previewSheetChartAxisMajor: "Major unit",
	/** Chart editor panel — the axis's number format code; empty follows the cells */
	previewSheetChartAxisFormat: "Number format",
	/** Chart editor panel — placeholder of an automatic field */
	previewSheetChartAuto: "Auto",
	/** Chart editor panel — placeholder of the number format field when it follows the cells */
	previewSheetChartLinked: "As in the cells",
	/** Chart editor panel — shows or hides an axis's major gridlines */
	previewSheetChartGridlines: "Gridlines",
	/** Chart editor panel — shows or hides the chart title */
	previewSheetChartTitleShow: "Show chart title",
	/** Chart editor panel — the chart title field */
	previewSheetChartTitle: "Chart title",
	/** Chart editor panel — placeholder of an empty chart title: the series' name is shown */
	previewSheetChartTitleAuto: "Automatic",
	/** Chart editor panel — legend position field */
	previewSheetChartLegend: "Legend",
	/** Legend positions — no legend */
	previewSheetChartLegendNone: "None",
	/** Legend positions — at the right */
	previewSheetChartLegendRight: "Right",
	/** Legend positions — at the left */
	previewSheetChartLegendLeft: "Left",
	/** Legend positions — at the top */
	previewSheetChartLegendTop: "Top",
	/** Legend positions — at the bottom */
	previewSheetChartLegendBottom: "Bottom",
	/** Legend positions — at the top right corner */
	previewSheetChartLegendTopRight: "Top right",
	/** Chart editor panel — data labels group */
	previewSheetChartLabels: "Data labels",
	/** Data labels — each point's value (Excel's "Value") */
	previewSheetChartLabelValue: "Value",
	/** Data labels — each point's category (Excel's "Category Name") */
	previewSheetChartLabelCategory: "Category name",
	/** Data labels — each point's series name (Excel's "Series Name") */
	previewSheetChartLabelSeries: "Series name",
	/** Data labels — each slice's share of a pie (Excel's "Percentage") */
	previewSheetChartLabelPercent: "Percentage",
	/** Data labels — where the labels sit */
	previewSheetChartLabelPosition: "Position",
	/** Label positions — Excel's automatic place */
	previewSheetChartPositionDefault: "Automatic",
	/** Label positions — the best place for each slice */
	previewSheetChartPositionBestFit: "Best fit",
	/** Label positions — centred */
	previewSheetChartPositionCenter: "Center",
	/** Label positions — inside the end of a bar or slice */
	previewSheetChartPositionInsideEnd: "Inside end",
	/** Label positions — inside the base of a bar */
	previewSheetChartPositionInsideBase: "Inside base",
	/** Label positions — outside the end of a bar or slice */
	previewSheetChartPositionOutsideEnd: "Outside end",
	/** Label positions — left of a point */
	previewSheetChartPositionLeft: "Left",
	/** Label positions — right of a point */
	previewSheetChartPositionRight: "Right",
	/** Label positions — above a point */
	previewSheetChartPositionAbove: "Above",
	/** Label positions — below a point */
	previewSheetChartPositionBelow: "Below",
	/** Toast — the chart holds something the editor cannot change without losing it */
	previewSheetChartUnsupported: "This chart uses features the editor doesn't support, so it can't be changed that way."
}
