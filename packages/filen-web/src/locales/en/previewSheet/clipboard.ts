// "preview" namespace, spreadsheet viewer — filling cells (the grid menu's Fill submenu and the
// Series dialog) and moving them by dragging the selection's border. Spread into preview.ts; same catalog rules.
export const previewSheetClipboard = {
	/** Confirmation dialog — title, when cells dragged by the selection's border are dropped over cells holding data */
	previewSheetMoveReplaceTitle: "Replace cells?",
	/** Confirmation dialog — body (Excel's wording): dropping the dragged cells there replaces what the cells hold */
	previewSheetMoveReplaceBody: "There's already data here. Do you want to replace it?",
	/** Confirmation dialog — confirm button: replaces the cells' data with the dragged cells */
	previewSheetMoveReplaceConfirm: "OK",
	/** Spreadsheet grid menu — submenu that fills the selection from its first cells */
	previewSheetFill: "Fill",
	/** Fill submenu — copies the selection's first row into the rest of it (Ctrl+D) */
	previewSheetFillDown: "Down",
	/** Fill submenu — copies the selection's first column into the rest of it (Ctrl+R) */
	previewSheetFillRight: "Right",
	/** Fill submenu — copies the selection's last row into the rest of it */
	previewSheetFillUp: "Up",
	/** Fill submenu — copies the selection's last column into the rest of it */
	previewSheetFillLeft: "Left",
	/** Fill submenu — opens the Series dialog */
	previewSheetFillSeries: "Series…",
	/** Series dialog — title */
	previewSheetSeriesTitle: "Series",
	/** Series dialog — what it does */
	previewSheetSeriesDescription: "Fill the selection with a series that starts from its first cells.",
	/** Series dialog — heading of whether each row or each column is a series */
	previewSheetSeriesIn: "Series in",
	/** Series dialog — each row of the selection is a series */
	previewSheetSeriesRows: "Rows",
	/** Series dialog — each column of the selection is a series */
	previewSheetSeriesColumns: "Columns",
	/** Series dialog — heading of the kind of series */
	previewSheetSeriesType: "Type",
	/** Series dialog — each value adds the step value */
	previewSheetSeriesLinear: "Linear",
	/** Series dialog — each value is multiplied by the step value */
	previewSheetSeriesGrowth: "Growth",
	/** Series dialog — dates stepping by the date unit */
	previewSheetSeriesDate: "Date",
	/** Series dialog — fills the blank cells from the filled ones, as dragging the fill handle does */
	previewSheetSeriesAutoFill: "AutoFill",
	/** Series dialog — heading of what a date series steps by */
	previewSheetSeriesDateUnit: "Date unit",
	/** Series dialog — date unit: days */
	previewSheetSeriesDay: "Day",
	/** Series dialog — date unit: weekdays (Monday to Friday) */
	previewSheetSeriesWeekday: "Weekday",
	/** Series dialog — date unit: months */
	previewSheetSeriesMonth: "Month",
	/** Series dialog — date unit: years */
	previewSheetSeriesYear: "Year",
	/** Series dialog — field: what each value adds (or multiplies by) */
	previewSheetSeriesStep: "Step value",
	/** Series dialog — field: where the series stops (optional) */
	previewSheetSeriesStop: "Stop value",
	/** Series dialog — placeholder of the stop value field: it may be left empty */
	previewSheetSeriesStopPlaceholder: "Optional",
	/** Series dialog — fits a trend to the starting values instead of using the step value */
	previewSheetSeriesTrend: "Trend",
	/** Series dialog — the step value is not a number */
	previewSheetSeriesStepInvalid: "Enter a number.",
	/** Series dialog — confirm button */
	previewSheetSeriesFill: "Fill",
	/** Toast — the Series dialog's stop value is not a number or a date (dates as 2024-12-31) */
	previewSheetSeriesStopInvalid: "The stop value must be a number or a date like 2024-12-31."
}
