; Meetily - Actually Free — NSIS installer dependency hooks
; Installed by Tauri via bundle.windows.nsis.installerHooks
;
; Ensures:
;   1) WebView2 is handled by Tauri (webviewInstallMode)
;   2) Visual C++ 2015–2022 x64 redistributable is present
;   3) CUDA / DirectML runtime DLLs sit next to meetily.exe

!include "LogicLib.nsh"
!include "x64.nsh"

; ---------------------------------------------------------------------------
; Helpers
; ---------------------------------------------------------------------------

; Returns 1 in $R9 if VC++ x64 runtime looks installed
!macro Meetily_CheckVcredist
  StrCpy $R9 0
  ; VS 2015–2022 universal runtime (most common)
  ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    StrCpy $R9 1
  ${Else}
    ReadRegDword $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
  ; Also accept newer "VCRedist" keys used by some VS 2022 builds
  ${If} $R9 == 0
    ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\2022\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
!macroend

!macro Meetily_InstallVcredist
  ; Bundled bootstrapper (staged under resources/runtime-deps by the build)
  StrCpy $R0 "$INSTDIR\resources\runtime-deps\vc_redist.x64.exe"
  ${If} ${FileExists} "$R0"
    DetailPrint "Installing Microsoft Visual C++ Redistributable (x64)..."
    ; Quiet install, no restart; ignore non-zero if already present
    nsExec::ExecToLog '"$R0" /install /quiet /norestart'
    Pop $0
    DetailPrint "VC++ redist installer exit code: $0"
  ${Else}
    DetailPrint "VC++ redist package not found in installer resources — skipping"
  ${EndIf}
!macroend

!macro Meetily_InstallCudaRuntime
  ; Copy GPU runtime DLLs next to the app binary so the CUDA build loads without
  ; a full system CUDA Toolkit install.
  StrCpy $R1 "$INSTDIR\resources\runtime-deps"
  ${If} ${FileExists} "$R1\cudart64_13.dll"
    DetailPrint "Installing CUDA / DirectML runtime libraries..."
    CopyFiles /SILENT "$R1\cudart64_13.dll" "$INSTDIR\"
    CopyFiles /SILENT "$R1\cublas64_13.dll" "$INSTDIR\"
    CopyFiles /SILENT "$R1\cublasLt64_13.dll" "$INSTDIR\"
    ${If} ${FileExists} "$R1\DirectML.dll"
      CopyFiles /SILENT "$R1\DirectML.dll" "$INSTDIR\"
    ${EndIf}
    DetailPrint "GPU runtime libraries installed next to Meetily."
  ${Else}
    DetailPrint "No bundled CUDA runtime found — GPU features may require a system CUDA install."
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; Tauri hooks
; ---------------------------------------------------------------------------

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Meetily: checking system dependencies..."
  ; Nothing blocking here — WebView2 is installed by Tauri's own NSIS section
  ; using webviewInstallMode. We only log intent.
  DetailPrint "WebView2 runtime will be ensured by the installer."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Meetily: installing runtime dependencies..."

  ; --- Visual C++ Redistributable ---
  !insertmacro Meetily_CheckVcredist
  ${If} $R9 == 0
    DetailPrint "Visual C++ runtime not detected — installing..."
    !insertmacro Meetily_InstallVcredist
  ${Else}
    DetailPrint "Visual C++ runtime already present."
  ${EndIf}

  ; --- CUDA / DirectML DLLs beside the exe ---
  !insertmacro Meetily_InstallCudaRuntime

  ; --- NVIDIA GPU advisory (non-blocking) ---
  nsExec::ExecToStack 'cmd /c where nvidia-smi >nul 2>&1'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Note: nvidia-smi not found. CUDA acceleration needs an NVIDIA GPU + driver."
    DetailPrint "The app still runs on CPU; GPU features will be limited."
  ${Else}
    DetailPrint "NVIDIA driver tools detected — CUDA acceleration available when supported."
  ${EndIf}

  DetailPrint "Meetily dependency setup complete."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop the app if still running so files can be removed
  nsExec::ExecToLog 'taskkill /IM meetily.exe /F'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Runtime DLLs we copied next to the exe are removed with $INSTDIR by Tauri.
  DetailPrint "Meetily uninstall finished."
!macroend
