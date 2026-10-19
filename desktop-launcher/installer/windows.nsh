; The per-user installer waits for runtime deployment before reporting completion.
!macro customInstall
  DetailPrint "Preparing the DSH runtime for this Windows account..."
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-runtime' $0
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Cannot start runtime installation. Close DSH Launcher and rerun Setup."
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "Runtime installation failed (exit $0). Close DSH Launcher, retain launcher.log in the application data directory, and rerun Setup."
  ${EndIf}
!macroend
