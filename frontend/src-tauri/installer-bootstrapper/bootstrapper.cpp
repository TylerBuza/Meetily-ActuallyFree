#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <bcrypt.h>
#include <commctrl.h>
#include <gdiplus.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <algorithm>
#include <atomic>
#include <cwctype>
#include <filesystem>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "resource.h"
#include "payload_hash.h"

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")
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
std::atomic<int> g_milestone{-1};
std::wstring g_install_dir;
std::wstring g_error;
std::wstring g_payload_path;
std::wstring g_progress_token;
std::wstring g_cuda_notice;
std::mutex g_result_mutex;
std::mutex g_detail_mutex;
std::wstring g_install_detail;
HFONT g_title_font = nullptr;
HFONT g_brand_font = nullptr;
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
  LOGFONTW log_font{};
  if (GetObjectW(font, sizeof(log_font), &log_font) == 0) return;

  Gdiplus::Graphics graphics(dc);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
  graphics.SetCompositingQuality(Gdiplus::CompositingQualityHighQuality);
  Gdiplus::Font draw_font(dc, &log_font);
  Gdiplus::SolidBrush brush(Gdiplus::Color(
      255, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff));
  Gdiplus::StringFormat string_format;
  string_format.SetAlignment(
      (format & DT_CENTER) ? Gdiplus::StringAlignmentCenter
      : (format & DT_RIGHT) ? Gdiplus::StringAlignmentFar
                            : Gdiplus::StringAlignmentNear);
  string_format.SetLineAlignment(
      (format & DT_VCENTER) ? Gdiplus::StringAlignmentCenter
                            : Gdiplus::StringAlignmentNear);
  if (format & DT_SINGLELINE) {
    string_format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  }
  const Gdiplus::RectF layout(
      static_cast<Gdiplus::REAL>(rect.left),
      static_cast<Gdiplus::REAL>(rect.top),
      static_cast<Gdiplus::REAL>(rect.right - rect.left),
      static_cast<Gdiplus::REAL>(rect.bottom - rect.top));
  graphics.DrawString(value.c_str(), static_cast<INT>(value.size()), &draw_font,
                      layout, &string_format, &brush);
}

void DrawChrome(HDC dc) {
  RECT client{0, 0, kWindowWidth, kWindowHeight};
  Fill(dc, client, 0x0d1117);

  Text(dc, L"Meetily", {34, 3, 146, 45}, g_brand_font, 0x4b88f7);
  Text(dc, L"\u00b7", {122, 3, 138, 45}, g_brand_font, 0x3b6fb3,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Actually Free", {138, 3, 338, 45}, g_brand_font, 0x3b6fb3);
  Text(dc, L"Actually Free Fork made by Tyler Buza  |  buza.dev",
       {390, 486, 736, 512}, g_small_font, 0x657a98,
       DT_RIGHT | DT_SINGLELINE | DT_VCENTER);

  HPEN chrome_pen = CreatePen(PS_SOLID, 1, Color(0x91a2ba));
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

void DrawCapability(HDC dc, int left, const wchar_t* title, const wchar_t* detail) {
  Text(dc, title, {left, 177, left + 176, 207}, g_heading_font, 0xeaf1fb,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, detail, {left + 8, 207, left + 168, 258}, g_small_font, 0x8fa4c0,
       DT_CENTER | DT_WORDBREAK | DT_VCENTER);
}

void DrawWelcome(HDC dc) {
  Text(dc, L"Meetings stay yours.", {72, 68, 688, 116}, g_title_font, 0xf2f6fc,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Private recording, transcription, speaker labels, and summaries on your PC.",
       {72, 112, 688, 142}, g_body_font, 0xa9bed9, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  RoundedFill(dc, {72, 158, 688, 264}, 14, 0x121925);
  Border(dc, {72, 158, 688, 264}, 14, 0x202c3e);
  Fill(dc, {277, 176, 278, 246}, 0x253247);
  Fill(dc, {482, 176, 483, 246}, 0x253247);
  DrawCapability(dc, 82, L"Private",
                 L"Audio, transcripts, and notes stay on this PC.");
  DrawCapability(dc, 287, L"Hardware-aware",
                 L"CUDA, Vulkan, or CPU is selected automatically.");
  DrawCapability(dc, 492, L"Actually free",
                 L"No accounts, limits, subscriptions, or telemetry.");

  Text(dc, L"INSTALL LOCATION", {72, 286, 300, 312}, g_small_font, 0x6da2f8);
  RoundedFill(dc, {72, 317, 558, 357}, 10, 0x090e15);
  Border(dc, {72, 317, 558, 357}, 10, 0x27354a);
  std::wstring shown = g_install_dir;
  if (shown.size() > 56) shown = L"..." + shown.substr(shown.size() - 53);
  Text(dc, shown, {88, 317, 542, 357}, g_small_font, 0xcbd8e9);
  RoundedFill(dc, BrowseRect(), 10, 0x1b2636);
  Text(dc, L"Browse", BrowseRect(), g_body_font, 0xdce7f5,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  RoundedFill(dc, InstallRect(), 12, 0x4b88f7);
  Text(dc, L"Install Meetily", InstallRect(), g_heading_font, 0xffffff,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Includes CPU, Vulkan, CUDA, and local speaker-labeling resources.",
       {72, 454, 688, 482}, g_small_font, 0x7890b2, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawProgress(HDC dc) {
  const bool extracting = g_page == Page::Extracting;
  const int progress = g_progress.load();
  const int milestone = g_milestone.load();
  std::wstring status;
  if (extracting) {
    status = L"Unpacking the bundled installer - no internet is used";
  } else if (milestone < 1) {
    status = L"Starting the local installation engine";
  } else if (milestone < 10) {
    status = L"Checking Microsoft WebView2 and installing it only if missing";
  } else if (milestone < 72) {
    status = L"Unpacking bundled application and model files";
  } else if (milestone < 78) {
    status = L"Registering Meetily for this Windows user";
  } else if (milestone < 80) {
    status = L"Creating app shortcuts";
  } else if (milestone < 85) {
    status = L"Checking the bundled Microsoft Visual C++ runtime";
  } else if (milestone < 90) {
    status = L"Installing bundled common local AI runtime files";
  } else if (milestone < 94) {
    status = L"Selecting the best local AI backend for this PC";
  } else if (milestone < 98) {
    status = L"Installing bundled backend runtime files";
  } else {
    status = L"Finishing setup";
  }
  Text(dc, extracting ? L"Preparing Meetily" : L"Installing Meetily",
       {72, 100, 688, 148}, g_title_font, 0xf2f6fc, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, status,
       {72, 149, 688, 180}, g_body_font, 0xa9bed9, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  std::wstring detail;
  if (extracting) {
    detail = progress >= 88 ? L"Verifying the embedded package with SHA-256"
                            : L"Writing the bundled NSIS engine to a temporary folder";
  } else {
    std::lock_guard<std::mutex> lock(g_detail_mutex);
    detail = g_install_detail;
  }
  if (detail.size() > 82) detail = detail.substr(0, 79) + L"...";
  Text(dc, detail, {72, 180, 688, 210}, g_small_font, 0x7890b2,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  RoundedFill(dc, {110, 230, 650, 242}, 8, 0x202b3c);
  if (extracting || progress >= 0) {
    const int width = std::max(8, (540 * std::max(0, progress)) / 100);
    RoundedFill(dc, {110, 230, 110 + width, 242}, 8, 0x4b88f7);
  } else {
    const int segment = 120;
    const int travel = 540 + segment;
    int left = 110 + ((g_spinner * 8) % travel) - segment;
    int right = left + segment;
    HRGN region = CreateRectRgn(110, 230, 650, 242);
    SelectClipRgn(dc, region);
    RoundedFill(dc, {left, 230, right, 242}, 8, 0x4b88f7);
    SelectClipRgn(dc, nullptr);
    DeleteObject(region);
  }

  Text(dc, (extracting || progress >= 0) ? std::to_wstring(std::max(0, progress)) + L"%"
                                         : L"Calculating progress...",
       {110, 252, 650, 282}, g_small_font, 0x7890b2, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  RoundedFill(dc, {110, 306, 650, 420}, 14, 0x121925);
  Border(dc, {110, 306, 650, 420}, 14, 0x202c3e);
  Text(dc, L"Installing to", {134, 314, 626, 338}, g_small_font, 0x6da2f8,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  std::wstring shown_path = g_install_dir;
  if (shown_path.size() > 62) shown_path = L"..." + shown_path.substr(shown_path.size() - 59);
  Text(dc, shown_path, {134, 338, 626, 362}, g_body_font, 0xdce7f5,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Setup uses bundled files and stays offline unless WebView2 is missing.",
       {134, 366, 626, 388}, g_small_font, 0x8fa4c0,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"If needed, Windows downloads WebView2 directly from Microsoft.",
       {134, 388, 626, 410}, g_small_font, 0x8fa4c0,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawCompleteBadge(HDC dc) {
  constexpr int badge_size = 72;
  constexpr int render_scale = 4;
  HDC badge_dc = CreateCompatibleDC(dc);
  HBITMAP badge_bitmap = CreateCompatibleBitmap(
      dc, badge_size * render_scale, badge_size * render_scale);
  HGDIOBJ old_bitmap = SelectObject(badge_dc, badge_bitmap);

  Fill(badge_dc, {0, 0, badge_size * render_scale, badge_size * render_scale}, 0x0d1117);
  HBRUSH circle = CreateSolidBrush(Color(0x2f6fdb));
  HGDIOBJ old_brush = SelectObject(badge_dc, circle);
  HGDIOBJ old_pen = SelectObject(badge_dc, GetStockObject(NULL_PEN));
  Ellipse(badge_dc, 0, 0, badge_size * render_scale, badge_size * render_scale);
  SelectObject(badge_dc, old_pen);
  SelectObject(badge_dc, old_brush);
  DeleteObject(circle);

  HPEN check = CreatePen(PS_SOLID, 4 * render_scale, Color(0xffffff));
  old_pen = SelectObject(badge_dc, check);
  MoveToEx(badge_dc, 17 * render_scale, 35 * render_scale, nullptr);
  LineTo(badge_dc, 31 * render_scale, 49 * render_scale);
  LineTo(badge_dc, 57 * render_scale, 20 * render_scale);
  SelectObject(badge_dc, old_pen);
  DeleteObject(check);

  SetStretchBltMode(dc, HALFTONE);
  SetBrushOrgEx(dc, 0, 0, nullptr);
  StretchBlt(dc, 344, 92, badge_size, badge_size,
             badge_dc, 0, 0, badge_size * render_scale,
             badge_size * render_scale, SRCCOPY);
  SelectObject(badge_dc, old_bitmap);
  DeleteObject(badge_bitmap);
  DeleteDC(badge_dc);
}

void DrawComplete(HDC dc) {
  DrawCompleteBadge(dc);
  std::wstring cuda_notice;
  {
    std::lock_guard<std::mutex> lock(g_result_mutex);
    cuda_notice = g_cuda_notice;
  }

  Text(dc, L"Meetily is ready.", {72, 182, 688, 232}, g_title_font, 0xf2f6fc,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, L"Launch it to finish the in-app welcome and audio check.", {72, 232, 688, 266},
       g_body_font, 0xa9bed9, DT_CENTER | DT_SINGLELINE | DT_VCENTER);

  if (cuda_notice.empty()) {
    RoundedFill(dc, {158, 294, 602, 352}, 12, 0x121925);
    Border(dc, {158, 294, 602, 352}, 12, 0x202c3e);
    Text(dc, L"INSTALLED IN", {178, 298, 582, 320}, g_small_font, 0x6da2f8,
         DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    std::wstring shown_path = g_install_dir;
    if (shown_path.size() > 54) shown_path = L"..." + shown_path.substr(shown_path.size() - 51);
    Text(dc, shown_path, {178, 320, 582, 346}, g_small_font, 0xb8c8dc,
         DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  } else {
    RoundedFill(dc, {100, 278, 660, 365}, 12, 0x2a2113);
    Border(dc, {100, 278, 660, 365}, 12, 0x6e5426);
    Text(dc, L"CUDA ACCELERATION IS NOT ENABLED", {120, 284, 640, 307},
         g_small_font, 0xf2bd62, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    Text(dc, cuda_notice, {120, 307, 640, 359}, g_small_font, 0xd6c29a,
         DT_CENTER | DT_WORDBREAK | DT_VCENTER);
  }

  RoundedFill(dc, LaunchRect(), 12, 0x4b88f7);
  Text(dc, L"Launch Meetily", LaunchRect(), g_heading_font, 0xffffff,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
}

void DrawFailed(HDC dc) {
  Text(dc, L"Setup could not finish", {72, 122, 688, 176}, g_title_font, 0xf2f6fc,
       DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  Text(dc, g_error, {110, 190, 650, 300}, g_body_font, 0xe8a2a2,
       DT_CENTER | DT_WORDBREAK | DT_VCENTER);
  RoundedFill(dc, LaunchRect(), 12, 0x1b2636);
  Text(dc, L"Close", LaunchRect(), g_heading_font, 0xdce7f5,
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
    return (path / L"Meetily-ActuallyFree").wstring();
  }
  return L"C:\\Meetily-ActuallyFree";
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
  g_progress_token = guid_text;
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

void CleanupProgressRegistry() {
  if (g_progress_token.empty()) return;
  const std::wstring key = L"Software\\meetily\\InstallerProgress\\" + g_progress_token;
  RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
}

struct ProgressSearch {
  DWORD process_id;
  HWND control;
  HWND status;
};

BOOL CALLBACK FindProgressChild(HWND window, LPARAM parameter) {
  auto* search = reinterpret_cast<ProgressSearch*>(parameter);
  wchar_t class_name[64];
  if (GetClassNameW(window, class_name, static_cast<int>(std::size(class_name))) > 0 &&
      _wcsicmp(class_name, PROGRESS_CLASSW) == 0) {
    search->control = window;
  }
  const int control_id = GetDlgCtrlID(window);
  if ((control_id == 1006 || control_id == 1008) && !search->status) {
    search->status = window;
  }
  return TRUE;
}

BOOL CALLBACK FindInstallerWindow(HWND window, LPARAM parameter) {
  auto* search = reinterpret_cast<ProgressSearch*>(parameter);
  DWORD process_id = 0;
  GetWindowThreadProcessId(window, &process_id);
  if (process_id != search->process_id) return TRUE;
  HWND previous_control = search->control;
  EnumChildWindows(window, FindProgressChild, parameter);
  // Hide only the stock NSIS progress window. A modal error/retry dialog has
  // no progress control and must remain visible so installation cannot deadlock.
  if (search->control && search->control != previous_control) {
    ShowWindowAsync(window, SW_HIDE);
  }
  return search->control == nullptr || search->status == nullptr;
}

int ReadInstallerProgress(DWORD process_id) {
  ProgressSearch search{process_id, nullptr, nullptr};
  EnumWindows(FindInstallerWindow, reinterpret_cast<LPARAM>(&search));
  if (!search.control) return -1;

  DWORD_PTR low = 0;
  DWORD_PTR high = 0;
  DWORD_PTR position = 0;
  if (!SendMessageTimeoutW(search.control, PBM_GETRANGE, TRUE, 0,
                           SMTO_ABORTIFHUNG, 50, &low) ||
      !SendMessageTimeoutW(search.control, PBM_GETRANGE, FALSE, 0,
                           SMTO_ABORTIFHUNG, 50, &high) ||
      !SendMessageTimeoutW(search.control, PBM_GETPOS, 0, 0,
                           SMTO_ABORTIFHUNG, 50, &position)) {
    return -1;
  }
  if (high <= low || position < low) return -1;
  return std::clamp(
      static_cast<int>(((position - low) * 100) / (high - low)), 0, 100);
}

std::wstring ReadInstallerDetail(DWORD process_id) {
  ProgressSearch search{process_id, nullptr, nullptr};
  EnumWindows(FindInstallerWindow, reinterpret_cast<LPARAM>(&search));
  if (!search.status) return {};
  wchar_t text[256]{};
  DWORD_PTR result = 0;
  if (!SendMessageTimeoutW(search.status, WM_GETTEXT, std::size(text),
                           reinterpret_cast<LPARAM>(text), SMTO_ABORTIFHUNG,
                           50, &result)) {
    return {};
  }
  return text;
}

int ReadInstallerMilestone() {
  if (g_progress_token.empty()) return -1;
  const std::wstring key = L"Software\\meetily\\InstallerProgress\\" + g_progress_token;
  DWORD percent = 0;
  DWORD size = sizeof(percent);
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"Percent", RRF_RT_REG_DWORD,
                   nullptr, &percent, &size) != ERROR_SUCCESS) {
    return -1;
  }
  return std::clamp(static_cast<int>(percent), 0, 100);
}

std::wstring ReadInstallerResult(const wchar_t* name) {
  if (g_progress_token.empty()) return {};
  const std::wstring key = L"Software\\meetily\\InstallerProgress\\" + g_progress_token;
  wchar_t text[1024]{};
  DWORD size = sizeof(text);
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, RRF_RT_REG_SZ,
                   nullptr, text, &size) != ERROR_SUCCESS) {
    return {};
  }
  return text;
}

int ParseOperationPercent(const std::wstring& detail) {
  const size_t percent = detail.rfind(L'%');
  if (percent == std::wstring::npos) return -1;
  size_t start = percent;
  while (start > 0 && std::iswdigit(detail[start - 1])) --start;
  if (start == percent) return -1;
  return std::clamp(std::stoi(detail.substr(start, percent - start)), 0, 100);
}

int ReadBundledByteProgress(const std::wstring& detail) {
  if (detail.empty() || kBundledFilesTotalBytes == 0) return -1;
  std::wstring folded_detail = detail;
  std::transform(folded_detail.begin(), folded_detail.end(), folded_detail.begin(), std::towlower);

  unsigned long long completed = 0;
  for (const auto& file : kBundledFiles) {
    std::wstring path = file.path;
    std::transform(path.begin(), path.end(), path.begin(), std::towlower);
    if (folded_detail.find(path) != std::wstring::npos) {
      const int operation_percent = ParseOperationPercent(detail);
      if (operation_percent < 0) return -1;
      const unsigned long long current = file.size * operation_percent / 100;
      const unsigned long long copied = std::min(completed + current, kBundledFilesTotalBytes);
      return 12 + static_cast<int>(copied * 60 / kBundledFilesTotalBytes);
    }
    completed += file.size;
  }
  return -1;
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
  g_progress.store(-1);
  PostMessageW(g_window, kWorkUpdate, 0, 0);
  std::wstring command = L"\"" + g_payload_path + L"\" /P /PROGRESSTOKEN=" +
      g_progress_token + L" /D=" + g_install_dir;
  std::vector<wchar_t> command_buffer(command.begin(), command.end());
  command_buffer.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(g_payload_path.c_str(), command_buffer.data(), nullptr, nullptr, FALSE,
                      CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup, &process)) {
    g_error = L"Windows could not start the installation engine.";
    CleanupPayload();
    PostMessageW(g_window, kWorkFailed, 0, 0);
    CoUninitialize();
    return;
  }
  while (WaitForSingleObject(process.hProcess, 100) == WAIT_TIMEOUT) {
    const int native_progress = ReadInstallerProgress(process.dwProcessId);
    const int milestone = ReadInstallerMilestone();
    if (milestone >= 0) g_milestone.store(milestone);
    std::wstring detail = ReadInstallerDetail(process.dwProcessId);
    const int byte_progress = ReadBundledByteProgress(detail);
    const int progress = milestone >= 12 && milestone < 72 && byte_progress >= 0
        ? byte_progress
        : std::max(native_progress, milestone);
    if (!detail.empty()) {
      std::lock_guard<std::mutex> lock(g_detail_mutex);
      g_install_detail = std::move(detail);
    }
    const int displayed_progress = g_progress.load();
    const int next_progress = std::max(displayed_progress, progress);
    if (progress >= 0 && next_progress != displayed_progress) {
      g_progress.store(next_progress);
      PostMessageW(g_window, kWorkUpdate, 0, 0);
    }
  }
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (exit_code == 0) {
    std::lock_guard<std::mutex> lock(g_result_mutex);
    g_cuda_notice = ReadInstallerResult(L"CudaNotice");
  }
  CleanupProgressRegistry();
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

  Gdiplus::GdiplusStartupInput gdiplus_input;
  ULONG_PTR gdiplus_token = 0;
  if (Gdiplus::GdiplusStartup(&gdiplus_token, &gdiplus_input, nullptr) != Gdiplus::Ok) {
    CoUninitialize();
    return 1;
  }

  g_title_font = CreateFontW(-36, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                             DEFAULT_PITCH, L"Segoe UI");
  g_brand_font = CreateFontW(-24, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                             DEFAULT_PITCH, L"Segoe UI");
  g_heading_font = CreateFontW(-17, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                               DEFAULT_PITCH, L"Segoe UI");
  g_body_font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                            DEFAULT_PITCH, L"Segoe UI");
  g_small_font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
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
  DeleteObject(g_brand_font);
  DeleteObject(g_heading_font);
  DeleteObject(g_body_font);
  DeleteObject(g_small_font);
  Gdiplus::GdiplusShutdown(gdiplus_token);
  CoUninitialize();
  return g_exit_code;
}
