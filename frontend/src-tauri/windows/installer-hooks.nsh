; Meetily - Actually Free — NSIS installer dependency hooks
; Tauri copies bundle.resources flat under $INSTDIR (e.g. $INSTDIR\runtime-deps\).
; The NSIS stub is 32-bit: use Sysnative / disable WOW64 redirection for 64-bit tools.

!include "LogicLib.nsh"
!include "x64.nsh"

!macro Meetily_CheckVcredist
  StrCpy $R9 0
  SetRegView 64
  ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    StrCpy $R9 1
  ${Else}
    ReadRegDword $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
  ${If} $R9 == 0
    ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\2022\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
  SetRegView lastused
!macroend

!macro Meetily_InstallVcredist
  ; Bundled next to other runtime-deps (NOT under resources\)
  StrCpy $R0 "$INSTDIR\runtime-deps\vc_redist.x64.exe"
  ${If} ${FileExists} "$R0"
    DetailPrint "      Running VC++ redistributable setup…"
    nsExec::ExecToLog '"$R0" /install /quiet /norestart'
    Pop $0
    DetailPrint "      VC++ installer exit code: $0"
  ${Else}
    DetailPrint "      VC++ package missing from bundle — skipped"
  ${EndIf}
!macroend

!macro Meetily_InstallCudaRuntime
  ; Tauri resource path: $INSTDIR\runtime-deps\*.dll
  StrCpy $R1 "$INSTDIR\runtime-deps"
  ${If} ${FileExists} "$R1\cudart64_13.dll"
    DetailPrint "      Copying CUDA / DirectML libraries next to Meetily…"
    CopyFiles /SILENT "$R1\cudart64_13.dll" "$INSTDIR\"
    ${If} ${FileExists} "$R1\cublas64_13.dll"
      CopyFiles /SILENT "$R1\cublas64_13.dll" "$INSTDIR\"
    ${EndIf}
    ${If} ${FileExists} "$R1\cublasLt64_13.dll"
      CopyFiles /SILENT "$R1\cublasLt64_13.dll" "$INSTDIR\"
    ${EndIf}
    ${If} ${FileExists} "$R1\DirectML.dll"
      CopyFiles /SILENT "$R1\DirectML.dll" "$INSTDIR\"
    ${EndIf}
    DetailPrint "      GPU runtime libraries installed."
  ${ElseIf} ${FileExists} "$INSTDIR\resources\runtime-deps\cudart64_13.dll"
    ; Fallback if resource layout ever nests under resources\
    StrCpy $R1 "$INSTDIR\resources\runtime-deps"
    DetailPrint "      Copying CUDA / DirectML libraries (nested resources path)…"
    CopyFiles /SILENT "$R1\cudart64_13.dll" "$INSTDIR\"
    CopyFiles /SILENT "$R1\cublas64_13.dll" "$INSTDIR\"
    CopyFiles /SILENT "$R1\cublasLt64_13.dll" "$INSTDIR\"
    ${If} ${FileExists} "$R1\DirectML.dll"
      CopyFiles /SILENT "$R1\DirectML.dll" "$INSTDIR\"
    ${EndIf}
    DetailPrint "      GPU runtime libraries installed."
  ${Else}
    DetailPrint "      WARNING: cudart64_13.dll not in bundle — GPU build may fail to start."
  ${EndIf}
!macroend

; Sets $R8=1 if an NVIDIA driver / nvidia-smi is present (WOW64-safe)
!macro Meetily_CheckNvidia
  StrCpy $R8 0
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$WINDIR\System32\nvidia-smi.exe"
    StrCpy $R8 1
  ${ElseIf} ${FileExists} "$WINDIR\Sysnative\nvidia-smi.exe"
    StrCpy $R8 1
  ${ElseIf} ${FileExists} "$PROGRAMFILES64\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    StrCpy $R8 1
  ${ElseIf} ${FileExists} "$PROGRAMFILES\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    StrCpy $R8 1
  ${EndIf}
  ${EnableX64FSRedirection}
  ; Registry fallback (driver package)
  ${If} $R8 == 0
    SetRegView 64
    EnumRegKey $0 HKLM "SOFTWARE\NVIDIA Corporation\GPU" 0
    ${If} $0 != ""
      StrCpy $R8 1
    ${EndIf}
    ReadRegStr $0 HKLM "SOFTWARE\NVIDIA Corporation\Global\NVTweak" "NvCplDaemon"
    ${If} $0 != ""
      StrCpy $R8 1
    ${EndIf}
    SetRegView lastused
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint both
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Meetily - Actually Free"
  DetailPrint " Installing app files…"
  DetailPrint "────────────────────────────────────────"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsPrint both
  DetailPrint ""
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Runtime setup"
  DetailPrint "────────────────────────────────────────"

  DetailPrint "[1/3] Visual C++ 2015–2022 (x64)…"
  !insertmacro Meetily_CheckVcredist
  ${If} $R9 == 0
    DetailPrint "      Not found — installing quietly…"
    !insertmacro Meetily_InstallVcredist
  ${Else}
    DetailPrint "      Already installed — skipped."
  ${EndIf}

  DetailPrint "[2/3] CUDA / DirectML GPU libraries…"
  !insertmacro Meetily_InstallCudaRuntime

  DetailPrint "[3/3] NVIDIA driver…"
  !insertmacro Meetily_CheckNvidia
  ${If} $R8 == 1
    DetailPrint "      NVIDIA driver detected — CUDA acceleration ready."
  ${Else}
    DetailPrint "      No NVIDIA driver detected."
    DetailPrint "      App still runs on CPU; install an NVIDIA driver for GPU speed."
  ${EndIf}

  DetailPrint ""
  DetailPrint "Runtime setup finished."
  DetailPrint "────────────────────────────────────────"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping Meetily if it is still running…"
  nsExec::ExecToLog 'taskkill /IM meetily.exe /F'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Meetily was removed from this user profile."
!macroend
