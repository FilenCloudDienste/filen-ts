// Layout math for the shared ActionSheet (src/providers/actionSheet.provider.tsx). Kept in its own
// dependency-free module so it can be unit-tested without loading the provider's native/React deps.
//
// @expo/react-native-action-sheet (v4) bottom-anchors the sheet and renders each option as a
// fixed-height row (its ActionGroup hard-codes button height: 56). It applies NO top safe-area inset
// itself, so the provider pads the container by insets.top to keep content out from under the status
// bar / notch — but only a sheet tall enough to actually reach that region needs it. On a short sheet
// (the common case) that padding is just an empty gap above the first row.

// @expo/react-native-action-sheet ActionGroup row height (its styles.button.height).
const ACTION_SHEET_ROW_HEIGHT = 56
// Approximate ActionGroup title block height (titleContainer paddingTop 24 + ~text 24 + paddingBottom 16).
const ACTION_SHEET_TITLE_HEIGHT = 64

// Whether a bottom-anchored ActionSheet with the given content is tall enough to reach into the top
// safe-area region, and therefore needs the top inset padding. A short sheet that fits on screen
// returns false, so the provider can drop the padding and avoid an empty gap above the first row.
//
// The sheet's top edge sits at windowHeight - estimatedSheetHeight; it intrudes under the status bar
// when that is less than insetTop, i.e. when estimatedSheetHeight > windowHeight - insetTop.
export function actionSheetNeedsTopInset({
	buttonCount,
	hasTitle,
	windowHeight,
	insetTop,
	insetBottom
}: {
	buttonCount: number
	hasTitle: boolean
	windowHeight: number
	insetTop: number
	insetBottom: number
}): boolean {
	const estimatedSheetHeight = buttonCount * ACTION_SHEET_ROW_HEIGHT + (hasTitle ? ACTION_SHEET_TITLE_HEIGHT : 0) + insetBottom

	return estimatedSheetHeight > windowHeight - insetTop
}
