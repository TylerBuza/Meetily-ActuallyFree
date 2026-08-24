; Meetily - Actually Free — NSIS installer dependency hooks
; Tauri copies bundle.resources flat under $INSTDIR (e.g. $INSTDIR\runtime-deps\).
; The NSIS stub is 32-bit: use Sysnative / disable WOW64 redirection for 64-bit tools.

!include "LogicLib.nsh"
!include "x64.nsh"

Var MeetilyBackend

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
    ${If} $0 != 0
    ${AndIf} $0 != 1638
    ${AndIf} $0 != 3010
      MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ Runtime installation failed (code $0). Meetily setup cannot continue."
      Abort
    ${EndIf}
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "The Microsoft Visual C++ Runtime package is missing. Meetily setup cannot continue."
    Abort
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

!macro Meetily_InstallCommonRuntime
  StrCpy $R1 "$INSTDIR\runtime-deps"
  ${If} ${FileExists} "$R1\DirectML.dll"
    CopyFiles /SILENT "$R1\DirectML.dll" "$INSTDIR\"
    DetailPrint "      DirectML / ONNX runtime installed."
  ${Else}
    DetailPrint "      WARNING: DirectML.dll missing from bundle."
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

; CUDA 13 requires a modern driver and this universal build targets Turing+
; (compute capability 7.5 and newer). Sets $R8=1 when both checks pass.
!macro Meetily_CheckCudaCapable
  StrCpy $R8 0
  StrCpy $R7 ""
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$WINDIR\System32\nvidia-smi.exe"
    StrCpy $R7 "$WINDIR\System32\nvidia-smi.exe"
  ${ElseIf} ${FileExists} "$WINDIR\Sysnative\nvidia-smi.exe"
    StrCpy $R7 "$WINDIR\Sysnative\nvidia-smi.exe"
  ${ElseIf} ${FileExists} "$PROGRAMFILES64\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    StrCpy $R7 "$PROGRAMFILES64\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
  ${EndIf}

  ${If} $R7 != ""
    nsExec::ExecToStack '"$R7" --id=0 --query-gpu=driver_version --format=csv,noheader,nounits'
    Pop $0
    Pop $1
    ${If} $0 == 0
      ${VersionCompare} "$1" "580.00" $2
      ${If} $2 != 2
        nsExec::ExecToStack '"$R7" --id=0 --query-gpu=compute_cap --format=csv,noheader,nounits'
        Pop $0
        Pop $1
        ${If} $0 == 0
          ${VersionCompare} "$1" "7.5" $2
          ${If} $2 != 2
            StrCpy $R8 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${EnableX64FSRedirection}
!macroend

; Sets $R6=1 when the 64-bit Vulkan loader can reach a usable physical device.
; The native x64 probe follows the loader's modern DCH discovery and rejects
; stale loaders with no physical device. The legacy registry scan is retained
; only as a compatibility fallback for packages that predate the probe.
!macro Meetily_CheckVulkan
  StrCpy $R6 0
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$WINDIR\System32\vulkan-1.dll"
    StrCpy $R6 1
  ${ElseIf} ${FileExists} "$WINDIR\Sysnative\vulkan-1.dll"
    StrCpy $R6 1
  ${EndIf}
  ${If} $R6 == 1
    StrCpy $R6 0
    StrCpy $R4 "$INSTDIR\installer-variants\meetily-vulkan-probe.exe"
    ${If} ${FileExists} "$R4"
      nsExec::ExecToStack /TIMEOUT=15000 '"$R4"'
      Pop $R3
      Pop $R2
      ${If} $R3 == 0
        StrCpy $R6 1
      ${Else}
        DetailPrint "      Vulkan probe found no usable device (code $R3)."
      ${EndIf}
    ${Else}
      DetailPrint "      Vulkan capability probe is missing; checking legacy drivers."
      StrCpy $R5 0
      SetRegView 64
      ${Do}
        EnumRegValue $R4 HKLM "SOFTWARE\Khronos\Vulkan\Drivers" $R5
        ${If} $R4 == ""
          ${ExitDo}
        ${EndIf}
        ReadRegDword $R3 HKLM "SOFTWARE\Khronos\Vulkan\Drivers" "$R4"
        ${If} $R3 == 0
        ${AndIf} ${FileExists} "$R4"
          StrCpy $R6 1
        ${EndIf}
        IntOp $R5 $R5 + 1
      ${LoopUntil} $R6 == 1
      SetRegView lastused
    ${EndIf}
  ${EndIf}
  ${EnableX64FSRedirection}
!macroend

; Pick and install the canonical meetily.exe. Optional command-line override:
;   /BACKEND=cuda | /BACKEND=vulkan | /BACKEND=cpu
!macro Meetily_SelectBackend
  StrCpy $MeetilyBackend ""
  ClearErrors
  ${GetOptions} $CMDLINE "/BACKEND=" $MeetilyBackend

  ; A standard Tauri bundle has no complete variant set. Keep its compiled
  ; executable instead of accidentally consuming stale local variant files.
  ${IfNot} ${FileExists} "$INSTDIR\installer-variants\universal.marker"
    StrCpy $MeetilyBackend "bundled"
    DetailPrint "      Standard bundle detected — keeping bundled executable."
  ${ElseIf} $MeetilyBackend == "cuda"
    !insertmacro Meetily_CheckCudaCapable
    ${If} $R8 != 1
      DetailPrint "      CUDA override unavailable — falling back to CPU."
      StrCpy $MeetilyBackend "cpu"
    ${EndIf}
  ${ElseIf} $MeetilyBackend == "vulkan"
    !insertmacro Meetily_CheckVulkan
    ${If} $R6 != 1
      DetailPrint "      Vulkan override unavailable — falling back to CPU."
      StrCpy $MeetilyBackend "cpu"
    ${EndIf}
  ${ElseIf} $MeetilyBackend == ""
    !insertmacro Meetily_CheckCudaCapable
    ${If} $R8 == 1
      StrCpy $MeetilyBackend "cuda"
    ${Else}
      !insertmacro Meetily_CheckVulkan
      ${If} $R6 == 1
        StrCpy $MeetilyBackend "vulkan"
      ${Else}
        StrCpy $MeetilyBackend "cpu"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $MeetilyBackend != "cpu"
    DetailPrint "      Unknown backend override — falling back to CPU."
    StrCpy $MeetilyBackend "cpu"
  ${EndIf}

  ; Invalid, unavailable, or missing variants always degrade safely to CPU.
  ${If} $MeetilyBackend == "bundled"
    StrCpy $R5 ""
  ${ElseIf} $MeetilyBackend == "cuda"
    StrCpy $R5 "$INSTDIR\installer-variants\meetily-cuda.exe"
  ${ElseIf} $MeetilyBackend == "vulkan"
    StrCpy $R5 "$INSTDIR\installer-variants\meetily-vulkan.exe"
  ${Else}
    StrCpy $MeetilyBackend "cpu"
    StrCpy $R5 "$INSTDIR\installer-variants\meetily-cpu.exe"
  ${EndIf}
  ${If} $MeetilyBackend != "bundled"
  ${AndIfNot} ${FileExists} "$R5"
    DetailPrint "      Requested backend binary missing — falling back to CPU."
    StrCpy $MeetilyBackend "cpu"
    StrCpy $R5 "$INSTDIR\installer-variants\meetily-cpu.exe"
  ${EndIf}

  ${If} $MeetilyBackend != "bundled"
    DetailPrint "      Selected transcription backend: $MeetilyBackend"
    CopyFiles /SILENT "$R5" "$INSTDIR\meetily.selected.exe"
    ${If} ${FileExists} "$INSTDIR\meetily.selected.exe"
      Delete "$INSTDIR\${MAINBINARYNAME}.exe"
      Rename "$INSTDIR\meetily.selected.exe" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${Else}
      DetailPrint "      Backend replacement failed — keeping bundled executable."
      StrCpy $MeetilyBackend "bundled"
    ${EndIf}
  ${EndIf}

  CreateDirectory "$INSTDIR\data"
  FileOpen $R4 "$INSTDIR\data\selected-backend.txt" w
  FileWrite $R4 "$MeetilyBackend$\r$\n"
  FileClose $R4

  RMDir /r "$INSTDIR\installer-variants"
!macroend

!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint both
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Meetily - Actually Free"
  ${If} $UpdateMode == 1
    DetailPrint " Updating app files…"
  ${Else}
    DetailPrint " Installing app files…"
  ${EndIf}
  DetailPrint "────────────────────────────────────────"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsPrint both
  DetailPrint ""
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Runtime setup"
  DetailPrint "────────────────────────────────────────"

  DetailPrint "[1/4] Visual C++ 2015–2022 (x64)…"
  !insertmacro MeetilyReportProgress 80
  !insertmacro Meetily_CheckVcredist
  ${If} $R9 == 0
    DetailPrint "      Not found — installing quietly…"
    !insertmacro Meetily_InstallVcredist
  ${Else}
    DetailPrint "      Already installed — skipped."
  ${EndIf}

  DetailPrint "[2/4] Common local AI runtime…"
  !insertmacro MeetilyReportProgress 85
  !insertmacro Meetily_InstallCommonRuntime

  DetailPrint "[3/4] Selecting CUDA, Vulkan, or CPU…"
  !insertmacro MeetilyReportProgress 90
  !insertmacro Meetily_SelectBackend

  DetailPrint "[4/4] Backend runtime…"
  !insertmacro MeetilyReportProgress 94
  ${If} $MeetilyBackend == "cuda"
    !insertmacro Meetily_InstallCudaRuntime
    DetailPrint "      NVIDIA CUDA enabled."
  ${ElseIf} $MeetilyBackend == "bundled"
    ; Harmless for CPU/Vulkan bundles and required for legacy CUDA bundles.
    !insertmacro Meetily_InstallCudaRuntime
    DetailPrint "      Bundled backend runtime installed."
  ${ElseIf} $MeetilyBackend == "vulkan"
    DetailPrint "      Vulkan enabled (AMD / Intel / compatible NVIDIA)."
  ${Else}
    DetailPrint "      CPU mode enabled — maximum compatibility."
  ${EndIf}

  DetailPrint ""
  DetailPrint "Runtime setup finished."
  !insertmacro MeetilyReportProgress 98
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
