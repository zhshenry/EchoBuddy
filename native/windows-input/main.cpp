#include <Windows.h>
#include <UIAutomation.h>
#include <ole2.h>
#include <oleacc.h>
#include <wrl/client.h>

#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "chat-target-watch.h"

using Microsoft::WRL::ComPtr;

struct Target {
    HWND foreground = nullptr;
    HWND focus = nullptr;
    HWND caret = nullptr;
    RECT caretRect{};
    DWORD process = 0;
    bool nativeEdit = false;
    bool paste = false;
    bool excelCell = false;
    DWORD selectionStart = 0;
    DWORD selectionEnd = 0;
    ComPtr<IUIAutomationElement> element;
    ComPtr<IUIAutomationTextRange> selection;

    bool hasCaret() const { return nativeEdit || selection || caret; }
};

static GUITHREADINFO guiThread(DWORD thread) {
    GUITHREADINFO info{sizeof(info)};
    return GetGUIThreadInfo(thread, &info) ? info : GUITHREADINFO{};
}

static bool isNativeEdit(HWND focus) {
    wchar_t name[64]{};
    return GetClassNameW(focus, name, ARRAYSIZE(name)) &&
        (_wcsicmp(name, L"Edit") == 0 || _wcsnicmp(name, L"RichEdit", 8) == 0);
}

static bool windowClassIs(HWND window, const wchar_t* expected) {
    wchar_t name[64]{};
    return GetClassNameW(window, name, ARRAYSIZE(name)) && _wcsicmp(name, expected) == 0;
}

static bool captureNativeEdit(Target& target) {
    DWORD_PTR result = 0;
    if (!SendMessageTimeoutW(target.focus, EM_GETSEL,
        reinterpret_cast<WPARAM>(&target.selectionStart), reinterpret_cast<LPARAM>(&target.selectionEnd),
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &result)) return false;
    target.nativeEdit = true;
    return true;
}

enum class InputApplication { standard, chat, excel };

static InputApplication classifyApplication(DWORD pid) {
    const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return InputApplication::standard;
    wchar_t path[MAX_PATH]{};
    DWORD size = ARRAYSIZE(path);
    const bool found = QueryFullProcessImageNameW(process, 0, path, &size) != FALSE;
    CloseHandle(process);
    if (!found) return InputApplication::standard;
    const wchar_t* name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    if (_wcsicmp(name, L"EXCEL.EXE") == 0) return InputApplication::excel;
    if (_wcsicmp(name, L"Weixin.exe") == 0 || _wcsicmp(name, L"WeChat.exe") == 0 || _wcsicmp(name, L"QQ.exe") == 0)
        return InputApplication::chat;
    return InputApplication::standard;
}

static ComPtr<IUIAutomationTextRange> selectionOf(IUIAutomationElement* element) {
    ComPtr<IUIAutomationTextPattern> text;
    ComPtr<IUIAutomationTextRangeArray> selections;
    ComPtr<IUIAutomationTextRange> range;
    int count = 0;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) && text &&
        SUCCEEDED(text->GetSelection(&selections)) && selections &&
        SUCCEEDED(selections->get_Length(&count))) {
        if (count == 1 && SUCCEEDED(selections->GetElement(0, &range))) return range;
        if (count > 1) return nullptr;
    }
    ComPtr<IUIAutomationTextPattern2> extended;
    BOOL active = FALSE;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPattern2Id, IID_PPV_ARGS(&extended))) && extended &&
        SUCCEEDED(extended->GetCaretRange(&active, &range)) && active) return range;
    return nullptr;
}

enum class Editability { unknown, readOnly, writable };

static Editability editability(IUIAutomationElement* element, IUIAutomationTextRange* range, bool paste) {
    if (range) {
        VARIANT readOnly;
        VariantInit(&readOnly);
        bool known = SUCCEEDED(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &readOnly)) && readOnly.vt == VT_BOOL;
        bool editable = known && readOnly.boolVal == VARIANT_FALSE;
        VariantClear(&readOnly);
        if (known) return editable ? Editability::writable : Editability::readOnly;
    }
    ComPtr<IUIAutomationValuePattern> value;
    BOOL readOnly = TRUE;
    CONTROLTYPEID kind = 0;
    if (SUCCEEDED(element->get_CurrentControlType(&kind)) && kind == UIA_EditControlTypeId &&
        SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value &&
        SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly))) return readOnly ? Editability::readOnly : Editability::writable;
    if (paste) {
        ComPtr<IUIAutomationLegacyIAccessiblePattern> legacy;
        DWORD state = 0, role = 0;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId, IID_PPV_ARGS(&legacy))) && legacy &&
            SUCCEEDED(legacy->get_CurrentState(&state))) {
            if (state & (STATE_SYSTEM_READONLY | STATE_SYSTEM_PROTECTED)) return Editability::readOnly;
            if ((state & STATE_SYSTEM_FOCUSED) && (state & STATE_SYSTEM_FOCUSABLE) &&
                SUCCEEDED(legacy->get_CurrentRole(&role)) && role == ROLE_SYSTEM_TEXT) return Editability::writable;
        }
    }
    return Editability::unknown;
}

static bool captureWindowCaret(Target& target, const GUITHREADINFO& info) {
    if (!info.hwndCaret || (info.hwndCaret != target.focus && !IsChild(target.focus, info.hwndCaret)) ||
        info.rcCaret.bottom <= info.rcCaret.top) return false;
    target.caret = info.hwndCaret;
    target.caretRect = info.rcCaret;
    return true;
}

static bool isSelectedExcelCell(IUIAutomationElement* element) {
    CONTROLTYPEID kind = 0;
    BOOL selected = FALSE;
    ComPtr<IUIAutomationSelectionItemPattern> item;
    return SUCCEEDED(element->get_CurrentControlType(&kind)) && kind == UIA_DataItemControlTypeId &&
        SUCCEEDED(element->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(&item))) && item &&
        SUCCEEDED(item->get_CurrentIsSelected(&selected)) && selected;
}

static Target capture(IUIAutomation* automation, DWORD appPid, ChatTargetWatch* watch = nullptr,
    DictationShortcut shortcut = {}, bool streaming = false) {
    Target target;
    target.foreground = GetForegroundWindow();
    const DWORD thread = GetWindowThreadProcessId(target.foreground, &target.process);
    if (!thread || !target.process || target.process == appPid) return {};
    const auto info = guiThread(thread);
    target.focus = info.hwndFocus;
    if (target.focus && !IsWindowEnabled(target.focus)) return {};
    const auto application = classifyApplication(target.process);
    target.paste = application == InputApplication::chat;
    const bool excel = application == InputApplication::excel && windowClassIs(target.foreground, L"XLMAIN");
    if (target.paste && !target.focus) return {};
    if (watch && streaming) watch->start(target.foreground, appPid, shortcut);
    if (target.focus && isNativeEdit(target.focus)) {
        if (GetWindowLongPtrW(target.focus, GWL_STYLE) & (ES_READONLY | ES_PASSWORD)) return {};
        if (captureNativeEdit(target)) return target;
    }
    if (excel && windowClassIs(target.focus, L"EXCEL6") && captureWindowCaret(target, info)) return target;
    if (watch && target.paste && !streaming) watch->start(target.foreground, appPid, shortcut);

    BOOL enabled = FALSE, password = TRUE;
    if (!automation || FAILED(automation->GetFocusedElement(&target.element)) || !target.element)
        return target.paste ? target : Target{};
    if (FAILED(target.element->get_CurrentIsEnabled(&enabled)) || !enabled ||
        FAILED(target.element->get_CurrentIsPassword(&password)) || password) return {};
    if (excel && windowClassIs(target.focus, L"EXCEL7") && isSelectedExcelCell(target.element.Get()) &&
        captureWindowCaret(target, info)) {
        target.excelCell = true;
        return target;
    }
    target.selection = selectionOf(target.element.Get());
    const auto editable = editability(target.element.Get(), target.selection.Get(), target.paste);
    if (editable == Editability::readOnly || (editable == Editability::unknown && !target.paste)) return {};
    if (editable == Editability::unknown) target.selection.Reset();
    if (target.paste && editable == Editability::writable && !target.selection) captureWindowCaret(target, info);
    return target;
}

static bool sameFocus(const Target& first, const Target& second) {
    return first.foreground && first.foreground == second.foreground &&
        first.process == second.process && first.focus == second.focus;
}

static bool sameEditor(IUIAutomation* automation, const Target& saved, const Target& current) {
    if (!sameFocus(saved, current) || bool(saved.element) != bool(current.element)) return false;
    BOOL sameElement = FALSE;
    return !saved.element || (automation &&
        SUCCEEDED(automation->CompareElements(saved.element.Get(), current.element.Get(), &sameElement)) && sameElement);
}

static bool sameTarget(IUIAutomation* automation, const Target& saved, const Target& current, const ChatTargetWatch& watch) {
    if (saved.nativeEdit)
        return sameFocus(saved, current) && current.nativeEdit &&
            saved.selectionStart == current.selectionStart && saved.selectionEnd == current.selectionEnd;
    if (!sameEditor(automation, saved, current)) return false;
    if (saved.caret) return saved.caret == current.caret && EqualRect(&saved.caretRect, &current.caretRect);
    if (!saved.selection) return saved.paste && current.paste && watch.unchanged();
    if (!current.selection) return false;
    int starts = 0, ends = 0;
    return SUCCEEDED(saved.selection->CompareEndpoints(TextPatternRangeEndpoint_Start, current.selection.Get(), TextPatternRangeEndpoint_Start, &starts)) &&
        SUCCEEDED(saved.selection->CompareEndpoints(TextPatternRangeEndpoint_End, current.selection.Get(), TextPatternRangeEndpoint_End, &ends)) &&
        starts == 0 && ends == 0;
}

static bool modifiersDown() {
    for (int key : {VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN}) {
        if (GetAsyncKeyState(key) & 0x8000) return true;
    }
    return false;
}

static bool stillFocused(const Target& target) {
    DWORD pid = 0;
    const DWORD thread = GetWindowThreadProcessId(target.foreground, &pid);
    if (GetForegroundWindow() != target.foreground || !thread || pid != target.process || modifiersDown()) return false;
    const auto info = guiThread(thread);
    return info.hwndFocus == target.focus &&
        !(info.flags & (GUI_INMENUMODE | GUI_INMOVESIZE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE)) &&
        (!target.caret || (info.hwndCaret == target.caret && EqualRect(&target.caretRect, &info.rcCaret)));
}

static bool beginExcelCellEdit(Target& target) {
    if (!stillFocused(target)) return false;
    INPUT edit[2]{};
    edit[0].type = edit[1].type = INPUT_KEYBOARD;
    edit[0].ki.wVk = edit[1].ki.wVk = VK_F2;
    edit[1].ki.dwFlags = KEYEVENTF_KEYUP;
    edit[0].ki.dwExtraInfo = edit[1].ki.dwExtraInfo = dictationInputTag;
    if (SendInput(ARRAYSIZE(edit), edit, sizeof(INPUT)) != ARRAYSIZE(edit)) return false;

    // Excel decides whether the selected cell can enter edit mode.
    const DWORD thread = GetWindowThreadProcessId(target.foreground, nullptr);
    const ULONGLONG deadline = GetTickCount64() + 400;
    do {
        if (GetForegroundWindow() != target.foreground) return false;
        const auto info = guiThread(thread);
        if (windowClassIs(info.hwndFocus, L"EXCEL6")) {
            if (info.hwndCaret && info.rcCaret.bottom > info.rcCaret.top) {
                if (!isSelectedExcelCell(target.element.Get())) return false;
                target.focus = info.hwndFocus;
                target.element.Reset();
                return captureWindowCaret(target, info);
            }
        } else if (info.hwndFocus != target.focus || (info.hwndCaret &&
            (info.hwndCaret != target.caret || !EqualRect(&info.rcCaret, &target.caretRect)))) {
            return false;
        }
        Sleep(10);
    } while (GetTickCount64() < deadline);
    return false;
}

static HGLOBAL clipboardMemory(const void* bytes, size_t size) {
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, size);
    if (!memory) return nullptr;
    void* destination = GlobalLock(memory);
    if (!destination) { GlobalFree(memory); return nullptr; }
    std::memcpy(destination, bytes, size);
    GlobalUnlock(memory);
    return memory;
}

static UINT clipboardHandleType(UINT format) {
    switch (format) {
        case CF_DSPBITMAP: return CF_BITMAP;
        case CF_DSPMETAFILEPICT: return CF_METAFILEPICT;
        case CF_DSPENHMETAFILE: return CF_ENHMETAFILE;
        default: return format;
    }
}

static void freeClipboardData(UINT format, HANDLE data) {
    if (!data) return;
    switch (clipboardHandleType(format)) {
        case CF_ENHMETAFILE: DeleteEnhMetaFile(static_cast<HENHMETAFILE>(data)); return;
        case CF_BITMAP:
        case CF_PALETTE: DeleteObject(data); return;
        case CF_METAFILEPICT:
            if (const auto picture = static_cast<const METAFILEPICT*>(GlobalLock(data))) {
                DeleteMetaFile(picture->hMF);
                GlobalUnlock(data);
            }
            break;
    }
    GlobalFree(data);
}

class ClipboardPaste {
public:
    ClipboardPaste(const Target& target, const std::wstring& text, const ChatTargetWatch* watch)
        : target_(target), watch_(watch) {
        text_ = clipboardMemory(text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        const DWORD marker = 1;
        exclude_ = clipboardMemory(&marker, sizeof(marker));
        const HINSTANCE instance = GetModuleHandleW(nullptr);
        static const ATOM windowClass = [] {
            WNDCLASSW definition{};
            definition.lpfnWndProc = renderFormat;
            definition.hInstance = GetModuleHandleW(nullptr);
            definition.lpszClassName = L"EchoBuddyClipboardPaste";
            return RegisterClassW(&definition);
        }();
        if (windowClass) owner_ = CreateWindowExW(0, MAKEINTATOM(windowClass), L"", 0, 0, 0, 0, 0,
            HWND_MESSAGE, nullptr, instance, nullptr);
        if (owner_) SetWindowLongPtrW(owner_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    }
    ClipboardPaste(const ClipboardPaste&) = delete;
    ClipboardPaste& operator=(const ClipboardPaste&) = delete;

    ~ClipboardPaste() {
        if (changed_ && open()) {
            // A copy made while the paste was in flight belongs to the user.
            if (GetClipboardOwner() == owner_ && EmptyClipboard()) {
                for (auto& [format, data] : previous_)
                    if (SetClipboardData(format, data)) data = nullptr;
            }
            CloseClipboard();
        }
        for (auto [format, data] : previous_) freeClipboardData(format, data);
        if (owner_) DestroyWindow(owner_);
        if (text_) GlobalFree(text_);
        if (exclude_) GlobalFree(exclude_);
    }

    bool snapshot() {
        if (!owner_ || !text_ || !exclude_ || !open()) return false;
        const bool saved = copyFormats();
        sequence_ = GetClipboardSequenceNumber();
        CloseClipboard();
        return saved;
    }

    bool publish() {
        const UINT excludeFormat = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
        if (!excludeFormat || !open()) return false;
        bool ready = false;
        if (sequence_ == GetClipboardSequenceNumber() && EmptyClipboard()) {
            changed_ = true;
            if (SetClipboardData(excludeFormat, exclude_)) {
                exclude_ = nullptr;
                // Wait for the destination to read the text before restoring the clipboard.
                SetClipboardData(CF_UNICODETEXT, nullptr);
                ready = IsClipboardFormatAvailable(CF_UNICODETEXT) != FALSE;
            }
        }
        CloseClipboard();
        return ready;
    }

    bool waitForRead() const {
        const ULONGLONG deadline = GetTickCount64() + 600;
        while (text_ && GetClipboardOwner() == owner_) {
            const ULONGLONG now = GetTickCount64();
            if (now >= deadline ||
                MsgWaitForMultipleObjects(0, nullptr, FALSE, static_cast<DWORD>(deadline - now), QS_SENDMESSAGE) != WAIT_OBJECT_0) break;
            MSG message{};
            PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        }
        return !text_;
    }

private:
    bool open() const {
        for (int attempt = 0; attempt < 20; ++attempt) {
            if (OpenClipboard(owner_)) return true;
            Sleep(10);
        }
        return false;
    }

    bool copyFormats() {
        UINT format = 0;
        for (;;) {
            SetLastError(ERROR_SUCCESS);
            format = EnumClipboardFormats(format);
            if (!format) return GetLastError() == ERROR_SUCCESS;
            if (format == CF_OWNERDISPLAY || (format >= CF_PRIVATEFIRST && format <= CF_GDIOBJLAST)) return false;
            const HANDLE data = GetClipboardData(format);
            if (!data) return false;
            const UINT kind = clipboardHandleType(format);
            const HANDLE copy = kind == CF_ENHMETAFILE ? CopyEnhMetaFileW(static_cast<HENHMETAFILE>(data), nullptr) :
                OleDuplicateData(data, static_cast<CLIPFORMAT>(kind), GMEM_MOVEABLE);
            if (!copy) return false;
            previous_.emplace_back(format, copy);
        }
    }

    static LRESULT CALLBACK renderFormat(HWND window, UINT message, WPARAM format, LPARAM param) {
        if (message == WM_RENDERFORMAT && format == CF_UNICODETEXT) {
            const auto paste = reinterpret_cast<ClipboardPaste*>(GetWindowLongPtrW(window, GWLP_USERDATA));
            DWORD reader = 0;
            GetWindowThreadProcessId(GetOpenClipboardWindow(), &reader);
            if (paste && paste->text_ && (!paste->watch_ || paste->watch_->unchanged()) &&
                GetForegroundWindow() == paste->target_.foreground &&
                (!reader || reader == paste->target_.process) && SetClipboardData(CF_UNICODETEXT, paste->text_)) {
                paste->text_ = nullptr;
            }
            return 0;
        }
        return DefWindowProcW(window, message, format, param);
    }

    const Target& target_;
    const ChatTargetWatch* watch_;
    HWND owner_ = nullptr;
    HGLOBAL text_ = nullptr;
    HGLOBAL exclude_ = nullptr;
    DWORD sequence_ = 0;
    bool changed_ = false;
    std::vector<std::pair<UINT, HANDLE>> previous_;
};

static const char* pasteText(IUIAutomation* automation, DWORD appPid, const Target* saved, const Target& current,
    const std::wstring& text, ULONGLONG deadline, const ChatTargetWatch& watch, bool streaming) {
    ClipboardPaste clipboard(current, text, streaming ? &watch : nullptr);
    if (!clipboard.snapshot()) return "unavailable";
    const Target confirmed = capture(automation, appPid);
    if (!sameFocus(current, confirmed) || !confirmed.paste ||
        (saved && !sameTarget(automation, *saved, confirmed, watch)) || !stillFocused(confirmed)) return "moved";
    // Leave time for the paste and clipboard restoration before the helper can time out.
    if (GetTickCount64() > deadline || !clipboard.publish()) return "unavailable";
    if (!stillFocused(confirmed) || (saved && (streaming || !saved->hasCaret()) && !watch.unchanged())) return "moved";
    INPUT keys[4]{};
    for (auto& key : keys) {
        key.type = INPUT_KEYBOARD;
        key.ki.dwExtraInfo = dictationInputTag;
    }
    keys[0].ki.wVk = keys[3].ki.wVk = VK_CONTROL;
    keys[1].ki.wVk = keys[2].ki.wVk = 'V';
    keys[2].ki.dwFlags = keys[3].ki.dwFlags = KEYEVENTF_KEYUP;
    const UINT sent = SendInput(ARRAYSIZE(keys), keys, sizeof(INPUT));
    if (sent && sent < ARRAYSIZE(keys)) {
        const UINT release = sent == 2 ? 2 : 3;
        SendInput(ARRAYSIZE(keys) - release, keys + release, sizeof(INPUT));
    }
    if (sent < 2) return "unavailable";
    return clipboard.waitForRead() && sent == ARRAYSIZE(keys) ? "written" : "partial";
}

static int hexDigit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static std::wstring decodeText(const std::string& hex) {
    if (hex.empty() || hex.size() % 4 || hex.size() > 480000) return {};
    std::wstring value;
    value.reserve(hex.size() / 4);
    for (size_t at = 0; at < hex.size(); at += 4) {
        int low1 = hexDigit(hex[at]), low2 = hexDigit(hex[at + 1]);
        int high1 = hexDigit(hex[at + 2]), high2 = hexDigit(hex[at + 3]);
        if (low1 < 0 || low2 < 0 || high1 < 0 || high2 < 0) return {};
        wchar_t character = static_cast<wchar_t>((high1 << 12) | (high2 << 8) | (low1 << 4) | low2);
        value.push_back(character < L' ' ? L' ' : character);
    }
    return value;
}

static bool caretAfterText(const Target& before, const Target& after, const std::wstring& text) {
    ComPtr<IUIAutomationTextRange> inserted;
    int selection = 0;
    if (!after.selection || FAILED(after.selection->CompareEndpoints(TextPatternRangeEndpoint_Start,
        after.selection.Get(), TextPatternRangeEndpoint_End, &selection)) || selection ||
        FAILED(before.selection->Clone(&inserted)) || !inserted ||
        FAILED(inserted->MoveEndpointByRange(TextPatternRangeEndpoint_End, after.selection.Get(), TextPatternRangeEndpoint_Start))) return false;

    BSTR value = nullptr;
    const bool complete = SUCCEEDED(inserted->GetText(static_cast<int>(text.size() + 1), &value)) && value &&
        SysStringLen(value) == text.size() && std::wmemcmp(value, text.data(), text.size()) == 0;
    SysFreeString(value);
    return complete;
}

static Target advanceTarget(IUIAutomation* automation, DWORD appPid, const Target& before,
    const std::wstring& text, const ChatTargetWatch& watch) {
    // A chat editor with an internal caret stays guarded by the original input watcher.
    if (!before.hasCaret()) return watch.unchanged() ? before : Target{};
    const ULONGLONG deadline = GetTickCount64() + 250;
    do {
        if (!watch.unchanged()) return {};
        const Target after = capture(automation, appPid);
        if (!watch.unchanged() || !sameEditor(automation, before, after)) return {};
        if (before.nativeEdit) {
            const size_t expected = before.selectionStart + text.size();
            if (after.nativeEdit && after.selectionStart == expected && after.selectionEnd == expected) return after;
        } else if (before.selection) {
            // UI Automation can report the caret after only the first keystrokes of a batch.
            if (caretAfterText(before, after, text)) return after;
        } else if (after.caret == before.caret && !EqualRect(&before.caretRect, &after.caretRect)) return after;
        Sleep(10);
    } while (GetTickCount64() < deadline);
    return {};
}

static const char* insertText(IUIAutomation* automation, DWORD appPid, const Target* saved, const std::wstring& text,
    const ChatTargetWatch& watch, Target* next = nullptr) {
    if (text.empty()) return "unavailable";
    if (next && !watch.unchanged()) return "moved";
    const ULONGLONG started = GetTickCount64();
    const ULONGLONG pasteDeadline = started + 2900;
    // The stop shortcut fires on keydown, and a ready transcript can arrive before keyup.
    const ULONGLONG releaseDeadline = started + 1500;
    while (modifiersDown()) {
        if (saved && GetForegroundWindow() != saved->foreground) return "moved";
        if (GetTickCount64() >= releaseDeadline) return "unavailable";
        Sleep(10);
    }

    Target current = capture(automation, appPid);
    if (!current.foreground || (saved && !sameTarget(automation, *saved, current, watch)) || (next && !watch.unchanged())) return "moved";
    if (current.paste) {
        const char* result = pasteText(automation, appPid, saved, current, text, pasteDeadline, watch, next != nullptr);
        if (next && std::strcmp(result, "written") == 0) {
            *next = advanceTarget(automation, appPid, current, text, watch);
            if (!next->foreground) return "partial";
        }
        return result;
    }
    if (next && current.nativeEdit) {
        // Insert the batch in one edit so a caret move cannot split it across positions.
        Target confirmed = current;
        if (!captureNativeEdit(confirmed) || !sameTarget(automation, current, confirmed, watch) ||
            !stillFocused(confirmed) || !watch.unchanged()) return "moved";
        DWORD_PTR result = 0;
        if (!SendMessageTimeoutW(confirmed.focus, EM_REPLACESEL, TRUE, reinterpret_cast<LPARAM>(text.c_str()),
            SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &result)) return "partial";
        *next = advanceTarget(automation, appPid, confirmed, text, watch);
        return next->foreground ? "written" : "partial";
    }
    if (current.excelCell && !beginExcelCellEdit(current)) return "unavailable";
    std::vector<INPUT> input;
    input.reserve(text.size() * 2);
    for (const wchar_t character : text) {
        INPUT item{};
        item.type = INPUT_KEYBOARD;
        item.ki.wScan = character;
        item.ki.dwFlags = KEYEVENTF_UNICODE;
        item.ki.dwExtraInfo = dictationInputTag;
        input.push_back(item);
        item.ki.dwFlags |= KEYEVENTF_KEYUP;
        input.push_back(item);
    }
    if (!stillFocused(current) || (next && !watch.unchanged())) return "moved";
    const UINT sent = SendInput(static_cast<UINT>(input.size()), input.data(), sizeof(INPUT));
    if (sent != input.size()) return sent ? "partial" : "unavailable";
    if (!next) return "written";
    *next = advanceTarget(automation, appPid, current, text, watch);
    return next->foreground ? "written" : "partial";
}

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    const auto appPid = std::strtoul(argv[1], nullptr, 10);
    if (!appPid || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
    {
        ComPtr<IUIAutomation> automation;
        CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
        ComPtr<IUIAutomation2> settings;
        if (automation && SUCCEEDED(automation.As(&settings))) {
            settings->put_ConnectionTimeout(500);
            settings->put_TransactionTimeout(700);
        }
        Target saved;
        ChatTargetWatch watch;
        bool streaming = false;
        std::string command;
        while (std::getline(std::cin, command)) {
            const char* response = "unavailable";
            const bool beginStreaming = command == "capture-stream" || command.rfind("capture-stream ", 0) == 0;
            if (beginStreaming || command == "capture" || command.rfind("capture ", 0) == 0) {
                watch.stop();
                streaming = beginStreaming;
                std::istringstream arguments(command);
                std::string verb;
                DictationShortcut shortcut;
                arguments >> verb >> shortcut.key >> shortcut.modifiers;
                saved = capture(automation.Get(), appPid, &watch, shortcut, streaming);
                const bool captured = saved.foreground && (streaming
                    ? watch.watching() && watch.unchanged() && (saved.hasCaret() || saved.paste)
                    : (watch.watching() ? watch.unchanged() : saved.hasCaret()));
                if (captured) response = "captured";
                else saved = {};
                if (!captured || (!streaming && saved.hasCaret())) watch.stop();
            } else if (command == "clear") {
                watch.stop();
                saved = {};
                response = "ok";
            } else if (command.rfind("insert ", 0) == 0) {
                Target next;
                response = insertText(automation.Get(), appPid, &saved, decodeText(command.substr(7)), watch, streaming ? &next : nullptr);
                saved = std::move(next);
                if (!saved.foreground) watch.stop();
            } else if (command.rfind("current ", 0) == 0) {
                response = insertText(automation.Get(), appPid, nullptr, decodeText(command.substr(8)), watch);
                saved = {};
            }
            std::cout << response << std::endl;
        }
    }
    CoUninitialize();
}
