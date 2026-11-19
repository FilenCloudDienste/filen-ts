import type { ChartText } from "@filen/office/core/drawingml"
import { i18n } from "@/lib/i18n"

// What charts show where the file names nothing (an unnamed series, an automatic chart or axis title) in the app's
// language, as the chart renderer takes them ("{n}" filled in with the series' position).
export function officeChartText(): ChartText {
	return {
		series: i18n.t("preview:previewOfficeChartSeriesName", { n: "{n}" }),
		chartTitle: i18n.t("preview:previewOfficeChartTitle"),
		axisTitle: i18n.t("preview:previewOfficeChartAxisTitle")
	}
}
