import { StyleSheet, type ViewStyle } from "react-native"

// One physical pixel for separators/dividers. These are style constants and
// not Tailwind utilities because the uniwind/Tailwind pipeline cannot express
// StyleSheet.hairlineWidth: Tailwind compiles @utility bodies (and :root
// variable values) before uniwind's function rewriter runs, silently dropping
// hairlineWidth() declarations — the resulting class applies no width at all.
// Border COLOR still comes from className (border-border); only the width
// lives here.
export const hairlineBorderBottom: ViewStyle = {
	borderBottomWidth: StyleSheet.hairlineWidth
}

export const hairlineHeight: ViewStyle = {
	height: StyleSheet.hairlineWidth
}

export const hairlineWidthStyle: ViewStyle = {
	width: StyleSheet.hairlineWidth
}
