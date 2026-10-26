; multiUser.nsh only moves the default install root to $PROGRAMFILES64 when APP_64 is defined, which the
; arm64-only installer lacks, so on Windows on ARM a fresh install would default to "Program Files (x86)".
; Only that untouched default is corrected: a registry-recorded location or /D= still wins.
!macro customInit
	${If} ${IsNativeARM64}
	${AndIf} $INSTDIR == "$PROGRAMFILES\${APP_FILENAME}"
		StrCpy $INSTDIR "$PROGRAMFILES64\${APP_FILENAME}"
	${EndIf}
!macroend

; WinFsp mounts the network drive. The bundled MSI (scripts/stageRclone.ts, pinned in rclone/versions.json) runs, per
; machine, when WinFsp is missing or older than it; that includes silent updates (--updated). Its version is read from
; versions.json at compile time and compared with the installed DLL's file version (major.minor.build); a WinFsp whose
; version cannot be read is treated as older, and the MSI's own upgrade logic decides. A failed MSI is logged and never
; fails the app's install: the app explains a missing WinFsp and can install it itself.
!searchparse /file "${__FILEDIR__}/rclone/versions.json" `"winfsp": "` WINFSP_MAJOR `.` WINFSP_MINOR `.` WINFSP_BUILD `"`

!macro customInstall
	; WinFsp registers under the 32-bit view only.
	SetRegView 32
	ReadRegStr $0 HKLM "SOFTWARE\WinFsp" "InstallDir"
	; Every target is 64-bit, where electron-builder's .onInit switched to the 64-bit view.
	SetRegView 64

	StrCpy $1 "install"

	${If} $0 != ""
		${If} ${IsNativeARM64}
			StrCpy $2 "$0\bin\winfsp-a64.dll"
		${Else}
			StrCpy $2 "$0\bin\winfsp-x64.dll"
		${EndIf}

		ClearErrors
		GetDLLVersion "$2" $3 $4

		${IfNot} ${Errors}
			; $3 = major << 16 | minor, $4 = build << 16 | revision.
			IntOp $5 ${WINFSP_MAJOR} << 16
			IntOp $5 $5 | ${WINFSP_MINOR}
			IntOp $6 ${WINFSP_BUILD} << 16

			${If} $3 U> $5
				StrCpy $1 ""
			${ElseIf} $3 == $5
			${AndIf} $4 U>= $6
				StrCpy $1 ""
			${EndIf}
		${EndIf}
	${EndIf}

	${If} $1 == "install"
		DetailPrint "Installing WinFsp ${WINFSP_MAJOR}.${WINFSP_MINOR}.${WINFSP_BUILD}"
		ClearErrors
		ExecWait '"$SYSDIR\msiexec.exe" /i "$INSTDIR\resources\deps\winfsp.msi" /qn /norestart' $7

		${If} ${Errors}
			DetailPrint "WinFsp: msiexec could not be started"
		${ElseIf} $7 == 0
		${OrIf} $7 == 3010
		${OrIf} $7 == 1641
		${OrIf} $7 == 1638
			DetailPrint "WinFsp: msiexec exit code $7"
		${Else}
			DetailPrint "WinFsp: msiexec failed with exit code $7; the app offers the install again"
		${EndIf}
	${EndIf}
!macroend
