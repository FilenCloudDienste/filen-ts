// "preview" namespace, spreadsheet viewer — sorting and filtering: the toolbar's sort and filter
// menu, the grid menu's items, the autofilter menu, its condition dialogs and the custom sort dialog. Spread into
// preview.ts; same catalog rules.
export const previewSheetSortFilter = {
	/** Spreadsheet toolbar — the sort and filter menu's button */
	previewSheetSortFilter: "Sort and filter",
	/** Sort command — orders the rows of the selection or its data by the active column, A first */
	previewSheetSortAscending: "Sort A to Z",
	/** Sort command — orders the rows of the selection or its data by the active column, Z first */
	previewSheetSortDescending: "Sort Z to A",
	/** Filter menu — sort command for a column of numbers, smallest first */
	previewSheetSortSmallest: "Sort smallest to largest",
	/** Filter menu — sort command for a column of numbers, largest first */
	previewSheetSortLargest: "Sort largest to smallest",
	/** Filter menu — sort command for a column of dates, oldest first */
	previewSheetSortOldest: "Sort oldest to newest",
	/** Filter menu — sort command for a column of dates, newest first */
	previewSheetSortNewest: "Sort newest to oldest",
	/** Toast — a sort is refused because the merged cells in its range differ in size (Excel's message) */
	previewSheetSortMergeSize: "To do this, all the merged cells need to be the same size.",
	/** Sort and filter menu — opens the dialog that sorts by several columns */
	previewSheetSortCustom: "Custom sort…",
	/** Spreadsheet grid menu — the submenu with the sort commands */
	previewSheetSortMenu: "Sort",
	/** Sort dialog — title */
	previewSheetSortTitle: "Sort",
	/** Sort dialog — what it does */
	previewSheetSortBody: "Order the rows by one column, then by the next where they are equal (up to 64 columns).",
	/** Sort dialog — what it does, sorting left to right */
	previewSheetSortBodyColumns: "Order the columns by one row, then by the next where they are equal (up to 64 rows).",
	/** Sort dialog — adds a sort level */
	previewSheetSortAddLevel: "Add level",
	/** Sort dialog — removes the chosen sort level */
	previewSheetSortDeleteLevel: "Delete level",
	/** Sort dialog — adds a copy of the chosen sort level */
	previewSheetSortCopyLevel: "Copy level",
	/** Sort dialog — moves the chosen sort level up */
	previewSheetSortMoveUp: "Move up",
	/** Sort dialog — moves the chosen sort level down */
	previewSheetSortMoveDown: "Move down",
	/** Sort dialog — the first row holds headings and stays in place */
	previewSheetSortHeaders: "My data has headers",
	/** Sort dialog — label of the first sort level */
	previewSheetSortBy: "Sort by",
	/** Sort dialog — label of every later sort level */
	previewSheetSortThenBy: "Then by",
	/** Sort dialog — the column (or row) a sort level orders by */
	previewSheetSortKey: "Column",
	/** Sort dialog — the row a level orders by, when sorting left to right */
	previewSheetSortKeyRow: "Row",
	/** Sort dialog — the order of a sort level */
	previewSheetSortOrder: "Order",
	/** Sort dialog — order option: ascending */
	previewSheetSortOrderAscending: "Ascending",
	/** Sort dialog — order option: descending */
	previewSheetSortOrderDescending: "Descending",
	/** Sort dialog — a column without a heading */
	previewSheetSortColumnName: "Column {{name}}",
	/** Sort dialog — a row to sort columns by */
	previewSheetSortRowName: "Row {{number}}",
	/** Sort dialog — uppercase and lowercase letters order apart */
	previewSheetSortCaseSensitive: "Case sensitive",
	/** Sort dialog — which way the sort goes */
	previewSheetSortOrientation: "Orientation",
	/** Sort dialog — rows are reordered */
	previewSheetSortTopToBottom: "Sort top to bottom",
	/** Sort dialog — columns are reordered */
	previewSheetSortLeftToRight: "Sort left to right",
	/** Sort dialog — confirms the sort */
	previewSheetSortApply: "Sort",
	/** Toast — a sort of a selection of more than one range */
	previewSheetSortOneRange: "Sorting works on one range at a time.",
	/** Sort and filter menu and grid menu — turns the autofilter on or off */
	previewSheetFilter: "Filter",
	/** Sort and filter menu — clears every filter of the range at the active cell */
	previewSheetFilterClearAll: "Clear filters",
	/** Sort and filter menu — applies the filters again to the cells as they now are */
	previewSheetFilterReapply: "Reapply",
	/** Spreadsheet grid menu — the submenu with the filter commands */
	previewSheetFilterMenu: "Filter",
	/** Grid menu — shows only the rows whose cell in this column holds the active cell's value */
	previewSheetFilterBySelected: "Filter by selected cell's value",
	/** Grid menu — shows only the rows whose cell in this column has the active cell's fill colour */
	previewSheetFilterBySelectedColor: "Filter by selected cell's color",
	/** Filter button — accessible name of a header's filter menu button */
	previewSheetFilterButton: "Filter {{name}}",
	/** Filter menu — removes this column's filter */
	previewSheetFilterClearColumn: "Clear filter from “{{name}}”",
	/** Filter menu — search field over the values list */
	previewSheetFilterSearch: "Search",
	/** Filter menu — the values list's first entry, checking or unchecking every value */
	previewSheetFilterSelectAll: "(Select all)",
	/** Filter menu — opens a year or month of the dates in the values list (followed by its name) */
	previewSheetFilterExpand: "Show",
	/** Filter menu — closes a year or month of the dates in the values list (followed by its name) */
	previewSheetFilterCollapse: "Hide",
	/** Filter menu — the values list's entry for empty cells */
	previewSheetFilterBlanks: "(Blanks)",
	/** Filter menu — accessible name of the values list */
	previewSheetFilterValues: "Values",
	/** Filter menu — the list shows only the first values */
	previewSheetFilterMore: "Showing the first {{count}} values",
	/** Filter menu — no value matches the search */
	previewSheetFilterNoMatches: "No values match",
	/** Filter menu — the column's filter cannot be changed in the list (icons, a criteria kind this app doesn't apply) */
	previewSheetFilterUnknown: "This column's filter can't be changed here.",
	/** Filter menu — confirms the checked values */
	previewSheetFilterApply: "OK",
	/** Filter menu — submenu of conditions for a column of text */
	previewSheetFilterText: "Text filters",
	/** Filter menu — submenu of conditions for a column of numbers */
	previewSheetFilterNumber: "Number filters",
	/** Filter menu — submenu of conditions for a column of dates */
	previewSheetFilterDate: "Date filters",
	/** Filter condition — the cell equals a value */
	previewSheetFilterEquals: "Equals…",
	/** Filter condition — the cell does not equal a value */
	previewSheetFilterNotEquals: "Does not equal…",
	/** Filter condition — the cell's text begins with a value */
	previewSheetFilterBeginsWith: "Begins with…",
	/** Filter condition — the cell's text ends with a value */
	previewSheetFilterEndsWith: "Ends with…",
	/** Filter condition — the cell's text contains a value */
	previewSheetFilterContains: "Contains…",
	/** Filter condition — the cell's text does not contain a value */
	previewSheetFilterNotContains: "Does not contain…",
	/** Filter condition — greater than a number */
	previewSheetFilterGreater: "Greater than…",
	/** Filter condition — greater than or equal to a number */
	previewSheetFilterGreaterOrEqual: "Greater than or equal to…",
	/** Filter condition — less than a number */
	previewSheetFilterLess: "Less than…",
	/** Filter condition — less than or equal to a number */
	previewSheetFilterLessOrEqual: "Less than or equal to…",
	/** Filter condition — between two numbers or dates */
	previewSheetFilterBetween: "Between…",
	/** Filter condition — the largest or smallest values */
	previewSheetFilterTop10: "Top 10…",
	/** Filter condition — above the column's average */
	previewSheetFilterAboveAverage: "Above average",
	/** Filter condition — below the column's average */
	previewSheetFilterBelowAverage: "Below average",
	/** Date filter — before a date */
	previewSheetFilterBefore: "Before…",
	/** Date filter — after a date */
	previewSheetFilterAfter: "After…",
	/** Date filter */
	previewSheetFilterTomorrow: "Tomorrow",
	/** Date filter */
	previewSheetFilterToday: "Today",
	/** Date filter */
	previewSheetFilterYesterday: "Yesterday",
	/** Date filter */
	previewSheetFilterNextWeek: "Next week",
	/** Date filter */
	previewSheetFilterThisWeek: "This week",
	/** Date filter */
	previewSheetFilterLastWeek: "Last week",
	/** Date filter */
	previewSheetFilterNextMonth: "Next month",
	/** Date filter */
	previewSheetFilterThisMonth: "This month",
	/** Date filter */
	previewSheetFilterLastMonth: "Last month",
	/** Date filter */
	previewSheetFilterNextQuarter: "Next quarter",
	/** Date filter */
	previewSheetFilterThisQuarter: "This quarter",
	/** Date filter */
	previewSheetFilterLastQuarter: "Last quarter",
	/** Date filter */
	previewSheetFilterNextYear: "Next year",
	/** Date filter */
	previewSheetFilterThisYear: "This year",
	/** Date filter */
	previewSheetFilterLastYear: "Last year",
	/** Date filter — from the start of this year to today */
	previewSheetFilterYearToDate: "Year to date",
	/** Date filter — submenu of quarters and months in any year */
	previewSheetFilterAllDatesIn: "All dates in the period",
	/** Date filter — a quarter of any year */
	previewSheetFilterQuarter: "Quarter {{number}}",
	/** Filter condition — opens the dialog with two conditions */
	previewSheetFilterCustom: "Custom filter…",
	/** Custom filter dialog — title */
	previewSheetFilterCustomTitle: "Custom filter",
	/** Custom filter dialog — what the conditions apply to */
	previewSheetFilterShowRowsWhere: "Show rows where “{{name}}”",
	/** Custom filter dialog — accessible name of a condition's operator (number: the condition's place, 1 or 2) */
	previewSheetFilterConditionOperator: "Condition {{number}}",
	/** Custom filter dialog — accessible name of a condition's value (number: the condition's place, 1 or 2) */
	previewSheetFilterConditionValue: "Value {{number}}",
	/** Custom filter dialog — both conditions must hold */
	previewSheetFilterAnd: "And",
	/** Custom filter dialog — either condition may hold */
	previewSheetFilterOr: "Or",
	/** Top 10 dialog — what it does */
	previewSheetFilterTop10Body: "Show the largest or smallest values of “{{name}}”.",
	/** Custom filter dialog — the wildcard hint */
	previewSheetFilterWildcards: "Use ? for any single character and * for any series of characters.",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpEquals: "equals",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpNotEquals: "does not equal",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpGreater: "is greater than",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpGreaterOrEqual: "is greater than or equal to",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpLess: "is less than",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpLessOrEqual: "is less than or equal to",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpBeginsWith: "begins with",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpNotBeginsWith: "does not begin with",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpEndsWith: "ends with",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpNotEndsWith: "does not end with",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpContains: "contains",
	/** Custom filter dialog — operator option */
	previewSheetFilterOpNotContains: "does not contain",
	/** Custom filter dialog — operator option for dates */
	previewSheetFilterOpBefore: "is before",
	/** Custom filter dialog — operator option for dates */
	previewSheetFilterOpAfter: "is after",
	/** Custom filter dialog — operator option for dates */
	previewSheetFilterOpOnOrBefore: "is on or before",
	/** Custom filter dialog — operator option for dates */
	previewSheetFilterOpOnOrAfter: "is on or after",
	/** Custom filter dialog — a second condition is not used */
	previewSheetFilterOpNone: "(none)",
	/** Custom filter dialog — a number condition's value does not read as a number */
	previewSheetFilterNotANumber: "Enter a number.",
	/** Top 10 dialog — title */
	previewSheetFilterTop10Title: "Top 10 filter",
	/** Top 10 dialog — the largest values */
	previewSheetFilterTop: "Top",
	/** Top 10 dialog — the smallest values */
	previewSheetFilterBottom: "Bottom",
	/** Top 10 dialog — how many */
	previewSheetFilterTopCount: "How many",
	/** Top 10 dialog — accessible name of the choice between the largest and the smallest values */
	previewSheetFilterTopDirection: "Top or bottom",
	/** Top 10 dialog — accessible name of the choice between counting items and percent */
	previewSheetFilterTopUnit: "Items or percent",
	/** Top 10 dialog — count in items */
	previewSheetFilterItems: "Items",
	/** Top 10 dialog — count in percent of the items */
	previewSheetFilterPercent: "Percent",
	/** Toast — the filter uses criteria this app cannot work out */
	previewSheetFilterCriteria: "This filter uses criteria Filen can't apply here, such as icons from conditional formatting."
}
