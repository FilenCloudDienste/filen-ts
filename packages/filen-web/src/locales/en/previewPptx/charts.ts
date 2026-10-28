// "preview" namespace, presentation editor: charts (Insert ▸ Chart, the contextual Chart tab and the Edit Data
// dialog). Chart types, legend places and the chart editor panel reuse the spreadsheet's previewSheetChart* keys.
// Spread into preview.ts; same catalog rules.
export const previewPptxCharts = {
	/** Presentation editor — Insert tab group and menu button: insert a chart */
	previewPptxInsertChart: "Chart",
	/** Presentation editor — Insert ▸ Chart menu heading over the chart types */
	previewPptxInsertChartTypes: "Chart type",
	/** Presentation editor — a new chart's sample data: the name of a category (row), e.g. "Category 1" */
	previewPptxChartSampleCategory: "Category {{number}}",
	/** Presentation editor — a new chart's sample data: the name of a series (column), e.g. "Series 1" */
	previewPptxChartSampleSeries: "Series {{number}}",
	/** Presentation editor — a new scatter chart's sample data: the x values' column */
	previewPptxChartSampleX: "X values",
	/** Presentation editor — a new scatter chart's sample data: the y values' column */
	previewPptxChartSampleY: "Y values",
	/** Presentation editor — Chart tab group: the chart's data */
	previewPptxChartData: "Data",
	/** Presentation editor — Chart tab button opening the chart's data in a sheet */
	previewPptxChartEditData: "Edit data",
	/** Presentation editor — Chart tab group and menu button: change the chart's type */
	previewPptxChartType: "Chart type",
	/** Presentation editor — Chart tab group: the chart's title, legend and data labels */
	previewPptxChartElements: "Chart elements",
	/** Presentation editor — Chart tab toggle: show the chart's title */
	previewPptxChartTitle: "Chart title",
	/** Presentation editor — Chart tab menu: where the legend shows */
	previewPptxChartLegend: "Legend",
	/** Presentation editor — Chart tab toggle: show each point's value on the chart */
	previewPptxChartLabels: "Data labels",
	/** Presentation editor — Chart tab button opening every chart setting (series, axes, title, legend, labels) */
	previewPptxChartFormat: "Format chart",
	/** Presentation editor — title of the dialog holding every chart setting */
	previewPptxChartFormatTitle: "Format chart",
	/** Presentation editor — tooltip of a disabled chart command: the chart cannot be read or changed here */
	previewPptxChartReadOnly: "This chart can't be changed here.",
	/** Presentation editor — tooltip of a disabled Edit data: the chart's data is in a file outside the presentation */
	previewPptxChartLinkedData: "This chart's data is in a file outside the presentation.",
	/** Presentation editor — Edit data dialog title */
	previewPptxChartDataTitle: "Chart data",
	/** Presentation editor — Edit data dialog description */
	previewPptxChartDataDescription: "Edit the cells the chart shows. The chart updates when you apply.",
	/** Presentation editor — Edit data dialog: accessible name of the sheet of cells */
	previewPptxChartDataGrid: "Chart data cells",
	/** Presentation editor — Edit data dialog: accessible name of the cell editor */
	previewPptxChartDataEditor: "Cell contents",
	/** Presentation editor — Edit data dialog button applying the edited cells to the chart */
	previewPptxChartDataApply: "Apply",
	/** Presentation editor — Edit data dialog while the chart's data opens */
	previewPptxChartDataLoading: "Opening the chart's data…",
	/** Presentation editor — Edit data dialog: the chart's data could not be opened */
	previewPptxChartDataFailed: "The chart's data could not be opened.",
	/** Presentation editor — Edit data dialog note: the chart's data was an old Excel 97–2003 workbook */
	previewPptxChartDataConverted:
		"This chart's data is an Excel 97–2003 workbook. When you apply, it is saved in the presentation as an Excel workbook (.xlsx).",
	/** Presentation editor — toast: the edited data could not be applied to the chart */
	previewPptxChartDataApplyFailed: "The chart could not be updated with this data."
} as const
