; multiUser.nsh only moves the default install root to $PROGRAMFILES64 when APP_64 is defined, which the
; arm64-only installer lacks, so on Windows on ARM a fresh install would default to "Program Files (x86)".
; Only that untouched default is corrected: a registry-recorded location or /D= still wins.
!macro customInit
	${If} ${IsNativeARM64}
	${AndIf} $INSTDIR == "$PROGRAMFILES\${APP_FILENAME}"
		StrCpy $INSTDIR "$PROGRAMFILES64\${APP_FILENAME}"
	${EndIf}
!macroend
