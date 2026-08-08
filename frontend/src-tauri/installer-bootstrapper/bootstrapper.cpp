#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "resource.h"
#include "payload_hash.h"

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

namespace {

constexpr int kWindowWidth = 760;
constexpr int kWindowHeight = 520;
constexpr UINT kWorkUpdate = WM_APP + 1;
constexpr UINT kWorkComplete = WM_APP + 2;
constexpr UINT kWorkFailed = WM_APP + 3;

enum class Page { Welcome, Extracting, Installing, Complete, Failed };

HWND g_window = nullptr;
std::atomic<Page> g_page{Page::Welcome};
std::atomic<int> g_progress{0};
std::wstring g_install_dir;
std::wstring g_error;
std::wstring g_payload_path;
HFONT g_title_font = nullptr;
HFONT g_heading_font = nullptr;
HFONT g_body_font = nullptr;
HFONT g_small_font = nullptr;
int g_spinner = 0;
int g_exit_code = 2;

RECT CloseRect() { return {kWindowWidth - 52, 0, kWindowWidth, 46}; }
RECT MinimizeRect() { return {kWindowWidth - 104, 0, kWindowWidth - 52, 46}; }
RECT BrowseRect() { return {570, 317, 688, 357}; }
RECT InstallRect() { return {72, 397, 688, 447}; }
RECT LaunchRect() { return {224, 385, 536, 435}; }

bool PointIn(const RECT& rect, int x, int y) {
  POINT point{x, y};
  return PtInRect(&rect, point) != FALSE;
}

COLORREF Color(unsigned hex) {
  return RGB((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
}

void Fill(HDC dc, const RECT& rect, unsigned color) {
  HBRUSH brush = CreateSolidBrush(Color(color));
  FillRect(dc, &rect, brush);
  DeleteObject(brush);
}

void RoundedFill(HDC dc, const RECT& rect, int radius, unsigned color) {
  HBRUSH brush = CreateSolidBrush(Color(color));
  HPEN pen = CreatePen(PS_SOLID, 1, Color(color));
  HGDIOBJ old_brush = SelectObject(dc, brush);
  HGDIOBJ old_pen = SelectObject(dc, pen);
  RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(dc, old_brush);
  SelectObject(dc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

void Border(HDC dc, const RECT& rect, int radius, unsigned color) {
  HPEN pen = CreatePen(PS_SOLID, 1, Color(color));
  HGDIOBJ old_pen = SelectObject(dc, pen);
  HGDIOBJ old_brush = SelectObject(dc, GetStockObject(NULL_BRUSH));
  RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(dc, old_brush);
  SelectObject(dc, old_pen);
  DeleteObject(pen);
}

void Text(HDC dc, const std::wstring& value, RECT rect, HFONT font, unsigned color,
          UINT format = DT_LEFT | DT_SINGLELINE | DT_VCENTER) {
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, Color(color));
  HGDIOBJ old_font = SelectObject(dc, font);
  DrawTextW(dc, value.c_str(), -1, &rect, format);
  SelectObject(dc, old_font);
}

void DrawChrome(HDC dc) {
  RECT client{0, 0, kWindowWidth, kWindowHeight};
  Fill(dc, client, 0x111722);

  HBRUSH logo_brush = CreateSolidBrush(Color(0x27c7b8));
  HGDIOBJ old_brush = SelectObject(dc, logo_brush);
  HGDIOBJ old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
  Ellipse(dc, 24, 15, 48, 39);
  SelectObject(dc, old_pen);
  SelectObject(dc, old_brush);
  DeleteObject(logo_brush);

  Text(dc, L"Meetily", {58, 8, 160, 46}, g_heading_font, 0xeaf0f8);
  Text(dc, L"ACTUALLY FREE", {132, 9, 270, 46}, g_small_font, 0x718096);

  HPEN chrome_pen = CreatePen(PS_SOLID, 1, Color(0x8e9aae));
  HGDIOBJ previous_pen = SelectObject(dc, chrome_pen);
  RECT min_rect = MinimizeRect();
  MoveToEx(dc, min_rect.left + 20, 25, nullptr);
  LineTo(dc, min_rect.right - 20, 25);
  RECT close_rect = CloseRect();
  MoveToEx(dc, close_rect.left + 20, 18, nullptr);
  LineTo(dc, close_rect.right - 20, 30);
  MoveToEx(dc, close_rect.right - 20, 18, nullptr);
  LineTo(dc, close_rect.left + 20, 30);
  SelectObject(dc, previous_pen);
  DeleteObject(chrome_pen);
}

void DrawFeature(HDC dc, int y, const wchar_t* title, const wchar_t* detail) {
  RoundedFill(dc, {72, y, 688, y + 58}, 12, 0x171f2c);
  Border(dc, {72, y, 688, y + 58}, 12, 0x263143);
  RoundedFill(dc, {88, y + 17, 112, y + 41}, 12, 0x183c3b);
  Text(dc, L"+", {88, y + 15, 112, y + 41}, g_heading_font, 0x35d1c1,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, title, {128, y + 7, 450, y + 31}, g_body_font, 0xeaf0f8);
  Text(dc, detail, {128, y + 28, 660, y + 50}, g_small_font, 0x8e9aae);
}

void DrawWelcome(HDC dc) {
  Text(dc, L"Meetings stay yours.", {72, 68, 688, 116}, g_title_font, 0xf4f7fb,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Private recording, transcription, speaker labels, and summaries on your PC.",
       {72, 112, 688, 142}, g_body_font, 0x9eabbd, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  DrawFeature(dc, 160, L"One installer", L"Automatically selects CUDA, Vulkan, or CPU.");
  DrawFeature(dc, 226, L"No account or subscription", L"Every feature is available. No analytics.");

  Text(dc, L"INSTALL LOCATION", {72, 286, 300, 312}, g_small_font, 0x64d9cd);
  RoundedFill(dc, {72, 317, 558, 357}, 10, 0x0c1119);
  Border(dc, {72, 317, 558, 357}, 10, 0x2a374a);
  std::wstring shown = g_install_dir;
  if (shown.size() > 56) shown = L"..." + shown.substr(shown.size() - 53);
  Text(dc, shown, {88, 317, 542, 357}, g_small_font, 0xcbd5e1);
  RoundedFill(dc, BrowseRect(), 10, 0x202a39);
  Text(dc, L"Browse", BrowseRect(), g_body_font, 0xdce4ee,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  RoundedFill(dc, InstallRect(), 12, 0x27b9ad);
  Text(dc, L"Install Meetily", InstallRect(), g_heading_font, 0x071211,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"About 810 MB. Setup detects compatible hardware automatically.",
       {72, 454, 688, 482}, g_small_font, 0x718096, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawProgress(HDC dc) {
  const bool extracting = g_page == Page::Extracting;
  Text(dc, extracting ? L"Preparing Meetily" : L"Installing Meetily",
       {72, 100, 688, 148}, g_title_font, 0xf4f7fb, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc,
       extracting ? L"Extracting and verifying the installation package..."
                  : L"Copying files and configuring the best local AI backend...",
       {72, 149, 688, 180}, g_body_font, 0x9eabbd, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  RoundedFill(dc, {110, 226, 650, 238}, 8, 0x222c3b);
  if (extracting) {
    const int width = std::max(8, (540 * g_progress.load()) / 100);
    RoundedFill(dc, {110, 226, 110 + width, 238}, 8, 0x31cabc);
  } else {
    const int segment = 120;
    const int travel = 540 + segment;
    int left = 110 + ((g_spinner * 8) % travel) - segment;
    int right = left + segment;
    HRGN region = CreateRectRgn(110, 226, 650, 238);
    SelectClipRgn(dc, region);
    RoundedFill(dc, {left, 226, right, 238}, 8, 0x31cabc);
    SelectClipRgn(dc, nullptr);
    DeleteObject(region);
  }

  Text(dc, extracting ? std::to_wstring(g_progress.load()) + L"%" : L"This can take a few minutes",
       {110, 248, 650, 278}, g_small_font, 0x7f8ca0, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  RoundedFill(dc, {154, 316, 606, 380}, 14, 0x171f2c);
  Border(dc, {154, 316, 606, 380}, 14, 0x263143);
  Text(dc, L"Please keep this window open", {178, 322, 582, 348}, g_body_font, 0xdce4ee,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Navigation is hidden while setup is working.", {178, 348, 582, 372}, g_small_font,
       0x8794a8, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawComplete(HDC dc) {
  RoundedFill(dc, {342, 102, 418, 178}, 38, 0x173d38);
  Text(dc, L"OK", {342, 102, 418, 178}, g_heading_font, 0x42d7c5,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Meetily is ready.", {72, 198, 688, 248}, g_title_font, 0xf4f7fb,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Launch it to finish the in-app welcome and audio check.", {72, 248, 688, 286},
       g_body_font, 0x9eabbd, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  RoundedFill(dc, LaunchRect(), 12, 0x27b9ad);
  Text(dc, L"Launch Meetily", LaunchRect(), g_heading_font, 0x071211,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawFailed(HDC dc) {
  Text(dc, L"Setup could not finish", {72, 122, 688, 176}, g_title_font, 0xf4f7fb,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, g_error, {110, 190, 650, 300}, g_body_font, 0xe8a2a2,
       DT_CENTER | DT_WORDBREAK | DT_VCENTER);
  RoundedFill(dc, LaunchRect(), 12, 0x202a39);
  Text(dc, L"Close", LaunchRect(), g_heading_font, 0xdce4ee,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

std::wstring DefaultInstallDirectory() {
  wchar_t registered_path[32768];
  DWORD registered_size = sizeof(registered_path);
  if (RegGetValueW(HKEY_CURRENT_USER,
                   L"Software\\meetily\\Meetily - Actually Free", nullptr,
                   RRF_RT_REG_SZ, nullptr, registered_path, &registered_size) == ERROR_SUCCESS &&
      registered_path[0] != L'\0') {
    return registered_path;
  }

  PWSTR local_app_data = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local_app_data))) {
    std::filesystem::path path(local_app_data);
    CoTaskMemFree(local_app_data);
    return (path / L"Meetily - Actually Free").wstring();
  }
  return L"C:\\Meetily - Actually Free";
}

std::wstring ChooseDirectory(HWND owner) {
  IFileOpenDialog* dialog = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&dialog)))) {
    return {};
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
  dialog->SetTitle(L"Choose where to install Meetily");
  std::wstring result;
  if (SUCCEEDED(dialog->Show(owner))) {
    IShellItem* item = nullptr;
    if (SUCCEEDED(dialog->GetResult(&item))) {
      PWSTR path = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
        result = path;
        CoTaskMemFree(path);
      }
      item->Release();
    }
  }
  dialog->Release();
  return result;
}

std::wstring Sha256Hex(const BYTE* data, DWORD size) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD result_size = 0;
  std::vector<BYTE> object;
  std::vector<BYTE> digest(32);

  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<BYTE*>(&object_size), sizeof(object_size),
                        &result_size, 0) < 0) {
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    return {};
  }
  object.resize(object_size);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_size, nullptr, 0, 0) < 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return {};
  }

  constexpr DWORD chunk_size = 4 * 1024 * 1024;
  DWORD offset = 0;
  while (offset < size) {
    DWORD chunk = std::min(chunk_size, size - offset);
    if (BCryptHashData(hash, const_cast<BYTE*>(data + offset), chunk, 0) < 0) {
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(algorithm, 0);
      return {};
    }
    offset += chunk;
  }
  if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) {
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return {};
  }
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);

  std::wostringstream output;
  output << std::hex << std::setfill(L'0');
  for (BYTE byte : digest) output << std::setw(2) << static_cast<unsigned>(byte);
  return output.str();
}

bool ExtractPayload(std::wstring& error) {
  HRSRC resource = FindResourceW(nullptr, MAKEINTRESOURCEW(IDR_NSIS_PAYLOAD), RT_RCDATA);
  if (!resource) {
    error = L"The embedded installation package is missing.";
    return false;
  }
  HGLOBAL loaded = LoadResource(nullptr, resource);
  const auto* bytes = static_cast<const BYTE*>(LockResource(loaded));
  DWORD size = SizeofResource(nullptr, resource);
  if (!bytes || size == 0) {
    error = L"The embedded installation package could not be read.";
    return false;
  }

  wchar_t temp_path[MAX_PATH];
  if (!GetTempPathW(MAX_PATH, temp_path)) {
    error = L"Windows did not provide a temporary folder.";
    return false;
  }
  GUID guid{};
  CoCreateGuid(&guid);
  wchar_t guid_text[64];
  StringFromGUID2(guid, guid_text, 64);
  std::filesystem::path directory = std::filesystem::path(temp_path) /
      (std::wstring(L"MeetilySetup-") + guid_text);
  std::error_code fs_error;
  std::filesystem::create_directories(directory, fs_error);
  if (fs_error) {
    error = L"Setup could not create its temporary folder.";
    return false;
  }
  g_payload_path = (directory / L"meetily-installer-engine.exe").wstring();

  HANDLE file = CreateFileW(g_payload_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_TEMPORARY, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    error = L"Setup could not create its temporary installation engine.";
    return false;
  }
  constexpr DWORD chunk_size = 1024 * 1024;
  DWORD offset = 0;
  while (offset < size) {
    DWORD chunk = std::min(chunk_size, size - offset);
    DWORD written = 0;
    if (!WriteFile(file, bytes + offset, chunk, &written, nullptr) || written != chunk) {
      CloseHandle(file);
      error = L"The installation package could not be extracted.";
      return false;
    }
    offset += chunk;
    g_progress.store(static_cast<int>((static_cast<unsigned long long>(offset) * 82) / size));
    PostMessageW(g_window, kWorkUpdate, 0, 0);
  }
  FlushFileBuffers(file);
  CloseHandle(file);

  g_progress.store(88);
  PostMessageW(g_window, kWorkUpdate, 0, 0);
  std::wstring hash = Sha256Hex(bytes, size);
  if (_wcsicmp(hash.c_str(), kExpectedPayloadSha256) != 0) {
    error = L"The installation package failed its integrity check.";
    return false;
  }
  g_progress.store(100);
  PostMessageW(g_window, kWorkUpdate, 0, 0);
  return true;
}

void CleanupPayload() {
  if (g_payload_path.empty()) return;
  std::error_code ignored;
  std::filesystem::path path(g_payload_path);
  std::filesystem::remove(path, ignored);
  std::filesystem::remove(path.parent_path(), ignored);
}

void InstallWorker() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  std::wstring error;
  if (!ExtractPayload(error)) {
    g_error = error;
    CleanupPayload();
    PostMessageW(g_window, kWorkFailed, 0, 0);
    CoUninitialize();
    return;
  }

  g_page = Page::Installing;
  PostMessageW(g_window, kWorkUpdate, 0, 0);
  std::wstring command = L"\"" + g_payload_path + L"\" /S /D=" + g_install_dir;
  std::vector<wchar_t> command_buffer(command.begin(), command.end());
  command_buffer.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(g_payload_path.c_str(), command_buffer.data(), nullptr, nullptr, FALSE,
                      CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup, &process)) {
    g_error = L"Windows could not start the installation engine.";
    CleanupPayload();
    PostMessageW(g_window, kWorkFailed, 0, 0);
    CoUninitialize();
    return;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CleanupPayload();

  if (exit_code == 0) {
    PostMessageW(g_window, kWorkComplete, 0, 0);
  } else {
    g_error = L"The installation engine returned error " + std::to_wstring(exit_code) + L".";
    PostMessageW(g_window, kWorkFailed, 0, 0);
  }
  CoUninitialize();
}

void StartInstall() {
  if (g_page != Page::Welcome || g_install_dir.empty()) return;
  g_page = Page::Extracting;
  g_progress.store(0);
  SetTimer(g_window, 1, 35, nullptr);
  InvalidateRect(g_window, nullptr, FALSE);
  std::thread(InstallWorker).detach();
}

void LaunchMeetily() {
  std::filesystem::path executable = std::filesystem::path(g_install_dir) / L"meetily.exe";
  ShellExecuteW(nullptr, L"open", executable.c_str(), nullptr, g_install_dir.c_str(), SW_SHOWNORMAL);
  DestroyWindow(g_window);
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case WM_NCHITTEST: {
      POINT point{GET_X_LPARAM(l_param), GET_Y_LPARAM(l_param)};
      ScreenToClient(window, &point);
      if (point.y < 46 && point.x < kWindowWidth - 104) return HTCAPTION;
      break;
    }
    case WM_LBUTTONUP: {
      const int x = GET_X_LPARAM(l_param);
      const int y = GET_Y_LPARAM(l_param);
      if (PointIn(MinimizeRect(), x, y)) {
        ShowWindow(window, SW_MINIMIZE);
      } else if (PointIn(CloseRect(), x, y)) {
        if (g_page != Page::Extracting && g_page != Page::Installing) DestroyWindow(window);
      } else if (g_page == Page::Welcome && PointIn(BrowseRect(), x, y)) {
        std::wstring chosen = ChooseDirectory(window);
        if (!chosen.empty()) g_install_dir = chosen;
        InvalidateRect(window, nullptr, FALSE);
      } else if (g_page == Page::Welcome && PointIn(InstallRect(), x, y)) {
        StartInstall();
      } else if (g_page == Page::Complete && PointIn(LaunchRect(), x, y)) {
        LaunchMeetily();
      } else if (g_page == Page::Failed && PointIn(LaunchRect(), x, y)) {
        DestroyWindow(window);
      }
      return 0;
    }
    case WM_KEYDOWN:
      if (w_param == VK_ESCAPE && g_page != Page::Extracting && g_page != Page::Installing) {
        DestroyWindow(window);
      } else if (w_param == VK_RETURN && g_page == Page::Welcome) {
        StartInstall();
      } else if (w_param == VK_RETURN && g_page == Page::Complete) {
        LaunchMeetily();
      }
      return 0;
    case WM_CLOSE:
      if (g_page != Page::Extracting && g_page != Page::Installing) DestroyWindow(window);
      return 0;
    case WM_TIMER:
      ++g_spinner;
      if (g_page == Page::Installing) InvalidateRect(window, nullptr, FALSE);
      return 0;
    case kWorkUpdate:
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    case kWorkComplete:
      g_page = Page::Complete;
      g_exit_code = 0;
      KillTimer(window, 1);
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    case kWorkFailed:
      g_page = Page::Failed;
      g_exit_code = 1;
      KillTimer(window, 1);
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      HDC dc = BeginPaint(window, &paint);
      HDC memory = CreateCompatibleDC(dc);
      HBITMAP bitmap = CreateCompatibleBitmap(dc, kWindowWidth, kWindowHeight);
      HGDIOBJ old_bitmap = SelectObject(memory, bitmap);
      DrawChrome(memory);
      if (g_page == Page::Welcome) DrawWelcome(memory);
      else if (g_page == Page::Extracting || g_page == Page::Installing) DrawProgress(memory);
      else if (g_page == Page::Complete) DrawComplete(memory);
      else DrawFailed(memory);
      BitBlt(dc, 0, 0, kWindowWidth, kWindowHeight, memory, 0, 0, SRCCOPY);
      SelectObject(memory, old_bitmap);
      DeleteObject(bitmap);
      DeleteDC(memory);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, w_param, l_param);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR command_line, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (wcscmp(command_line, L"--verify-payload") == 0) {
    std::wstring error;
    const bool verified = ExtractPayload(error);
    CleanupPayload();
    CoUninitialize();
    return verified ? 0 : 1;
  }
  g_install_dir = DefaultInstallDirectory();

  g_title_font = CreateFontW(-36, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH, L"Segoe UI");
  g_heading_font = CreateFontW(-17, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                              OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH, L"Segoe UI");
  g_body_font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH, L"Segoe UI");
  g_small_font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH, L"Segoe UI");

  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = WindowProc;
  window_class.hInstance = instance;
  window_class.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_MEETILY));
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.lpszClassName = L"MeetilyInstallerBootstrapper";
  RegisterClassExW(&window_class);

  RECT work_area{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work_area, 0);
  int x = work_area.left + ((work_area.right - work_area.left) - kWindowWidth) / 2;
  int y = work_area.top + ((work_area.bottom - work_area.top) - kWindowHeight) / 2;
  g_window = CreateWindowExW(WS_EX_APPWINDOW, window_class.lpszClassName,
                             L"Meetily - Actually Free Setup", WS_POPUP,
                             x, y, kWindowWidth, kWindowHeight, nullptr, nullptr, instance, nullptr);
  if (!g_window) return 1;

  const DWORD corner = 2;
  DwmSetWindowAttribute(g_window, 33, &corner, sizeof(corner));
  const BOOL dark = TRUE;
  DwmSetWindowAttribute(g_window, 20, &dark, sizeof(dark));
  ShowWindow(g_window, SW_SHOW);
  UpdateWindow(g_window);

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  DeleteObject(g_title_font);
  DeleteObject(g_heading_font);
  DeleteObject(g_body_font);
  DeleteObject(g_small_font);
  CoUninitialize();
  return g_exit_code;
}
