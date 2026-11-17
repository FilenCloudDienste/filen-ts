// "preview" namespace, rich viewers — the SQLite database browser. Spread into preview.ts; same catalog rules.
export const previewRichSqlite = {
	/** SQLite viewer — heading of the list of tables, with their count */
	previewSqliteTables: "Tables ({{count, number}})",
	/** SQLite viewer — heading of the list of views, with their count */
	previewSqliteViews: "Views ({{count, number}})",
	/** SQLite viewer — heading of the list of virtual tables (full-text indexes, R-trees), with their count */
	previewSqliteVirtual: "Virtual ({{count, number}})",
	/** SQLite viewer — tab showing a table's rows */
	previewSqliteTabData: "Data",
	/** SQLite viewer — tab showing a table's SQL definition */
	previewSqliteTabSchema: "Schema",
	/** SQLite viewer — a table's row count, exact */
	previewSqliteRows_one: "{{count, number}} row",
	previewSqliteRows_other: "{{count, number}} rows",
	/** SQLite viewer — a table's row count not counted to the end (still counting, or a large database counted only as far as it was read): at least this many */
	previewSqliteRowsAtLeast: "≥ {{count, number}} rows",
	/** SQLite viewer — button beside "≥ N rows" on a large database: count every row of the table (reads all of it) */
	previewSqliteCount: "Count",
	/** SQLite viewer — tooltip of the Count button */
	previewSqliteCountTitle: "Count every row (reads the whole table)",
	/** SQLite viewer — the table's rows are being counted; the count beside it grows as it goes */
	previewSqliteCounting: "Counting…",
	/** SQLite viewer — shown above the grid when it starts past the first rows (after Go to row), e.g. "Rows 2,000,001–" */
	previewSqliteWindow: "Rows {{from, number}}–",
	/** SQLite viewer — button opening the field to jump to a row number */
	previewSqliteGoToRow: "Go to row",
	/** SQLite viewer — accessible name of the row number field */
	previewSqliteGoToRowLabel: "Row number",
	/** SQLite viewer — button jumping to the typed row */
	previewSqliteGo: "Go",
	/** SQLite viewer — accessible name of the grid of a table's rows */
	previewSqliteGrid: "Table rows",
	/** SQLite viewer — accessible name of the grid's (unused) cell editor */
	previewSqliteGridEditor: "Cell",
	/** SQLite viewer — a cell's value is NULL */
	previewSqliteNull: "NULL",
	/** SQLite viewer — a text value too large to show in a cell, with its size */
	previewSqliteLargeText: "Text, {{size}}",
	/** SQLite viewer — a binary value, with its size */
	previewSqliteBlob: "BLOB, {{size}}",
	/** SQLite viewer — the selected cell's bar: table, column and row, e.g. "users.email, row 2" */
	previewSqliteSelected: "{{table}}.{{column}}, row {{row, number}}",
	/** SQLite viewer — button showing the selected cell's whole value */
	previewSqliteFullValue: "Full value",
	/** SQLite viewer — a value too large to show whole (over 1 MB): its start is shown */
	previewSqliteValueTooLarge: "This value is {{size}}; its start is shown.",
	/** SQLite viewer — a binary value's start is shown as a hex dump */
	previewSqliteHexDump: "First {{size}} as hex",
	/** SQLite viewer — a view is listed with its SQL and never run */
	previewSqliteViewNotRun: "View — its SQL is shown, it is not run.",
	/** SQLite viewer — a virtual table is listed with its SQL and never queried */
	previewSqliteVirtualNotBrowsed: "Virtual table — not browsed.",
	/** SQLite viewer — a table without columns */
	previewSqliteNoColumns: "This table has no columns.",
	/** SQLite viewer — the database holds no tables */
	previewSqliteEmpty: "This database has no tables.",
	/** SQLite viewer — the file was saved in WAL mode: what is still in its -wal file is not shown */
	previewSqliteWal: "Changes still in the WAL file are not shown.",
	/** SQLite viewer — chip: the integrity check has not run (large databases run it only when asked) */
	previewSqliteNotChecked: "Not checked",
	/** SQLite viewer — button running the integrity check on a large database */
	previewSqliteCheck: "Check integrity",
	/** SQLite viewer — the integrity check is running, with its progress, e.g. "Checking 412 MB / 1.3 GB" */
	previewSqliteChecking: "Checking {{read}} / {{total}}",
	/** SQLite viewer — the integrity check is running, progress unknown */
	previewSqliteCheckingUnknown: "Checking…",
	/** SQLite viewer — chip: the integrity check passed */
	previewSqliteChecked: "Checked",
	/** SQLite viewer — the integrity check could not finish (a read failed) */
	previewSqliteCheckFailed: "The check couldn't finish.",
	/** SQLite viewer — the file does not start with the SQLite header (or it is encrypted); shown with Download */
	previewSqliteNotSqlite: "Not a SQLite database (or encrypted).",
	/** SQLite viewer — the integrity check or the schema found damage; shown with Download */
	previewSqliteDamaged: "The database is damaged.",
	/** SQLite viewer — reading the database failed (network, timeout); shown with Retry */
	previewSqliteUnreadable: "Couldn't read the database."
} as const
