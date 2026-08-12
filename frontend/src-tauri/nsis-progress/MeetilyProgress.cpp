#include <windows.h>
#include <commctrl.h>
#include <uxtheme.h>

#include <algorithm>
#include <cwctype>
#include <string>

#include "progress_files.h"

struct stack_t {
  stack_t* next;
  wchar_t text[1];
};

enum NSPIM { NSPIM_UNLOAD, NSPIM_GUIUNLOAD };
using NSISPLUGINCALLBACK = UINT_PTR(__cdecl*)(NSPIM);
struct extra_parameters {
  void* exec_flags;
  int(__stdcall* ExecuteCodeSegment)(int, HWND);
  void(__stdcall* validate_filename)(wchar_t*);
  int(__stdcall* RegisterPluginCallback)(HMODULE, NSISPLUGINCALLBACK);
};

namespace {

constexpr UINT kOverallProgressMessage = WM_APP + 0x4D1;
constexpr int kExtractionStart = 12;
constexpr int kExtractionEnd = 72;

HINSTANCE g_instance = nullptr;
HWND g_outer = nullptr;
HWND g_status = nullptr;
HWND g_stock_progress = nullptr;
HWND g_overall_progress = nullptr;
int g_displayed_percent = 0;
std::wstring g_current_file;

std::wstring NormalizePath(std::wstring value) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  while (!value.empty() && iswspace(value.front())) value.erase(value.begin());
  while (!value.empty() && iswspace(value.back())) value.pop_back();
  std::transform(value.begin(), value.end(), value.begin(), towlower);
  return value;
}

void SetOverallProgress(int percent) {
  percent = std::clamp(percent, 0, 100);
  if (percent < g_displayed_percent) return;
  g_displayed_percent = percent;

  if (g_overall_progress && IsWindow(g_overall_progress)) {
    SendMessageW(g_overall_progress, PBM_SETPOS, percent * 100, 0);
  }
  if (g_outer && IsWindow(g_outer)) {
    if (HWND header = GetDlgItem(g_outer, 1038)) {
      wchar_t text[256];
      wsprintfW(text, L"Updating app files to version %s  |  %d%% complete",
                kMeetilyVersion, percent);
      SetWindowTextW(header, text);
    }
  }
}

bool ParseExtraction(const wchar_t* raw, std::wstring& path, int& file_percent) {
  if (!raw) return false;
  std::wstring text(raw);
  const auto colon = text.find(L':');
  const auto ellipsis = text.rfind(L"...");
  const auto percent_sign = text.rfind(L'%');
  if (colon != std::wstring::npos && text.find(L"Extract", 0) != std::wstring::npos) {
    const size_t path_end = ellipsis == std::wstring::npos ? text.size() : ellipsis;
    if (path_end > colon) g_current_file = NormalizePath(text.substr(colon + 1, path_end - colon - 1));
  }
  if (percent_sign == std::wstring::npos || g_current_file.empty()) return false;
  size_t number_start = percent_sign;
  while (number_start > 0 && iswdigit(text[number_start - 1])) --number_start;
  if (number_start == percent_sign) return false;
  path = g_current_file;
  file_percent = std::clamp(_wtoi(text.substr(number_start, percent_sign - number_start).c_str()), 0, 100);
  return !path.empty();
}

void UpdateFromExtraction(const wchar_t* text) {
  std::wstring current_path;
  int file_percent = 0;
  if (!ParseExtraction(text, current_path, file_percent) || kBundledFilesTotalBytes == 0) {
    return;
  }

  unsigned long long completed = 0;
  for (const auto& file : kBundledFiles) {
    const std::wstring expected = NormalizePath(file.path);
    const bool matches = current_path == expected ||
        (current_path.size() > expected.size() &&
         current_path.compare(current_path.size() - expected.size(), expected.size(), expected) == 0);
    if (matches) {
      const unsigned long long within_file = file.size * static_cast<unsigned long long>(file_percent) / 100ULL;
      const int extraction_percent = static_cast<int>(
          (completed + within_file) * static_cast<unsigned long long>(kExtractionEnd - kExtractionStart) /
          kBundledFilesTotalBytes);
      SetOverallProgress(kExtractionStart + extraction_percent);
      return;
    }
    completed += file.size;
  }
}

LRESULT CALLBACK StatusSubclass(HWND window, UINT message, WPARAM w_param, LPARAM l_param,
                                UINT_PTR, DWORD_PTR) {
  if (message == WM_SETTEXT) {
    UpdateFromExtraction(reinterpret_cast<const wchar_t*>(l_param));
  } else if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(window, StatusSubclass, 1);
    g_status = nullptr;
  }
  return DefSubclassProc(window, message, w_param, l_param);
}

LRESULT CALLBACK OuterSubclass(HWND window, UINT message, WPARAM w_param, LPARAM l_param,
                               UINT_PTR, DWORD_PTR) {
  if (message == kOverallProgressMessage) {
    SetOverallProgress(static_cast<int>(w_param));
    return 0;
  }
  if (message == WM_NCDESTROY) {
    RemoveWindowSubclass(window, OuterSubclass, 1);
    g_outer = nullptr;
  }
  return DefSubclassProc(window, message, w_param, l_param);
}

void Cleanup() {
  if (g_status && IsWindow(g_status)) RemoveWindowSubclass(g_status, StatusSubclass, 1);
  if (g_outer && IsWindow(g_outer)) RemoveWindowSubclass(g_outer, OuterSubclass, 1);
  g_status = nullptr;
  g_outer = nullptr;
  g_stock_progress = nullptr;
  g_overall_progress = nullptr;
  g_current_file.clear();
}

UINT_PTR __cdecl PluginCallback(NSPIM message) {
  if (message == NSPIM_GUIUNLOAD || message == NSPIM_UNLOAD) Cleanup();
  return 0;
}

}  // namespace

extern "C" __declspec(dllexport) void Start(
    HWND hwnd_parent, int string_size, wchar_t* variables, stack_t** stacktop,
    extra_parameters* extra, ...) {
  (void)string_size;
  (void)variables;
  (void)stacktop;
  Cleanup();

  // The update extraction phase begins at the matching NSIS milestone. Avoid
  // reading the NSIS stack so this tiny UI plugin has no SDK/runtime dependency.
  g_displayed_percent = kExtractionStart;
  g_outer = hwnd_parent;

  HWND inner = FindWindowExW(g_outer, nullptr, L"#32770", nullptr);
  if (!inner) return;
  g_stock_progress = GetDlgItem(inner, 1004);
  g_status = GetDlgItem(inner, 1006);
  if (!g_stock_progress || !g_status) return;

  RECT rect{};
  GetWindowRect(g_stock_progress, &rect);
  MapWindowPoints(nullptr, inner, reinterpret_cast<POINT*>(&rect), 2);
  g_overall_progress = CreateWindowExW(
      0, PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE | PBS_SMOOTH,
      rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top,
      inner, nullptr, g_instance, nullptr);
  if (!g_overall_progress) return;

  SetWindowTheme(g_overall_progress, L"", L"");
  SendMessageW(g_overall_progress, PBM_SETRANGE32, 0, 10000);
  SendMessageW(g_overall_progress, PBM_SETBARCOLOR, 0, 0xF7884B);
  SendMessageW(g_overall_progress, PBM_SETBKCOLOR, 0, 0x1C1512);
  ShowWindow(g_stock_progress, SW_HIDE);
  SetWindowSubclass(g_status, StatusSubclass, 1, 0);
  SetWindowSubclass(g_outer, OuterSubclass, 1, 0);
  extra->RegisterPluginCallback(g_instance, PluginCallback);
  SetOverallProgress(g_displayed_percent);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_instance = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}
