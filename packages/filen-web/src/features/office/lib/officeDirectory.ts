import { DOT_FILEN_SUBDIRS } from "@filen/shared"
import { dotFilenDirectory } from "@/lib/dotFilenDirectory"

// `.filen/office`, where the document files of the user live (the spelling dictionary, the document settings).

export const OFFICE_DIR_NAME = DOT_FILEN_SUBDIRS.office

export const officeDirectory = dotFilenDirectory(OFFICE_DIR_NAME)
