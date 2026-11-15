import { createContext, use, useEffect, type RefObject } from "react"
import type { ReportSubject } from "@/features/publicLinks/lib/report.logic"

// What the report dialog says the visitor is on: the link views write it, the shell's footer reads it when
// the dialog opens. A ref, not state: the shell never re-renders for a browse step, and the value lives
// only in memory for as long as the page shows. The shell provides it.
export const ReportSubjectContext = createContext<RefObject<ReportSubject> | null>(null)

export const EMPTY_REPORT_SUBJECT: ReportSubject = { password: undefined, viewing: [] }

export function useReportSubjectRef(): RefObject<ReportSubject> | null {
	return use(ReportSubjectContext)
}

// The link's accepted password, cleared when the view goes.
export function useReportPassword(password: string | undefined): void {
	const subjectRef = use(ReportSubjectContext)

	useEffect(() => {
		if (subjectRef === null) {
			return
		}

		subjectRef.current = { ...subjectRef.current, password }

		return () => {
			subjectRef.current = { ...subjectRef.current, password: undefined }
		}
	}, [subjectRef, password])
}

// The directory link's browse path and opened file, cleared when the browser goes.
export function useReportViewing(viewing: readonly string[]): void {
	const subjectRef = use(ReportSubjectContext)

	useEffect(() => {
		if (subjectRef === null) {
			return
		}

		subjectRef.current = { ...subjectRef.current, viewing }

		return () => {
			subjectRef.current = { ...subjectRef.current, viewing: EMPTY_REPORT_SUBJECT.viewing }
		}
	}, [subjectRef, viewing])
}
