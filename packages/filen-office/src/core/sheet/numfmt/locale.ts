// What number formats show that depends on a language: the app injects it (the core reads no Intl locale). Codes in
// files always use "." and "," (MS-OI29500 §2.1.712 b: the code grammar is en-US); the shown text uses these.
export interface NumFmtLocale {
	readonly decimal: string
	readonly group: string
	// January first.
	readonly months: readonly string[]
	readonly monthsShort: readonly string[]
	// Sunday first.
	readonly days: readonly string[]
	readonly daysShort: readonly string[]
	readonly am: string
	readonly pm: string
	// The system short date (built-in 14, and 22 before " h:mm"), long date and time ([$-F800], [$-F400]) as format
	// codes. The file keeps the code it has; only what shows follows these.
	readonly shortDate: string
	readonly longDate: string
	readonly longTime: string
	// Built-in ids whose code depends on the language (currency 5-8 and 41-44, the East Asian and Thai ids 27-36
	// and 50-81): ECMA-376 Part 1 §18.8.30 leaves them to the application.
	readonly builtins: Readonly<Record<number, string>>
}

// en-US, as Excel writes and shows it.
export const NUMFMT_EN_US: NumFmtLocale = {
	decimal: ".",
	group: ",",
	months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
	monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
	daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	am: "AM",
	pm: "PM",
	shortDate: "m/d/yyyy",
	longDate: "dddd, mmmm d, yyyy",
	longTime: "h:mm:ss AM/PM",
	builtins: {
		5: '"$"#,##0_);\\("$"#,##0\\)',
		6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
		7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
		8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
		41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
		42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
		43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
		44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'
	}
}
