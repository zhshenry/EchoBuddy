#include <Windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>

#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

using Microsoft::WRL::ComPtr;

struct Target {
    HWND foreground = nullptr;
    HWND focus = nullptr;
    DWORD process = 0;
    bool nativeEdit = false;
    DWORD selectionStart = 0;
    DWORD selectionEnd = 0;
    ComPtr<IUIAutomationElement> element;
    ComPtr<IUIAutomationTextRange> selection;
};

static HWND focusedWindow(DWORD thread) {
    GUITHREADINFO info{sizeof(info)};
    return GetGUIThreadInfo(thread, &info) ? info.hwndFocus : nullptr;
}

static bool captureNativeEdit(Target& target) {
    wchar_t name[64]{};
    if (!target.focus || !GetClassNameW(target.focus, name, ARRAYSIZE(name))) return false;
    if (_wcsicmp(name, L"Edit") != 0 && _wcsnicmp(name, L"RichEdit", 8) != 0) return false;
    auto style = GetWindowLongPtrW(target.focus, GWL_STYLE);
    if (!IsWindowEnabled(target.focus) || (style & (ES_READONLY | ES_PASSWORD))) return false;
    DWORD_PTR result = 0;
    if (!SendMessageTimeoutW(target.focus, EM_GETSEL,
        reinterpret_cast<WPARAM>(&target.selectionStart), reinterpret_cast<LPARAM>(&target.selectionEnd),
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, &result)) return false;
    target.nativeEdit = true;
    return true;
}

static ComPtr<IUIAutomationTextRange> selectionOf(IUIAutomationElement* element) {
    ComPtr<IUIAutomationTextPattern> text;
    ComPtr<IUIAutomationTextRangeArray> selections;
    ComPtr<IUIAutomationTextRange> range;
    int count = 0;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&text))) &&
        SUCCEEDED(text->GetSelection(&selections)) && selections &&
        SUCCEEDED(selections->get_Length(&count))) {
        if (count == 1 && SUCCEEDED(selections->GetElement(0, &range))) return range;
        if (count > 1) return nullptr;
    }
    ComPtr<IUIAutomationTextPattern2> extended;
    BOOL active = FALSE;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPattern2Id, IID_PPV_ARGS(&extended))) &&
        SUCCEEDED(extended->GetCaretRange(&active, &range)) && active) return range;
    return nullptr;
}

static bool writable(IUIAutomationElement* element, IUIAutomationTextRange* range) {
    if (range) {
        VARIANT readOnly;
        VariantInit(&readOnly);
        bool known = SUCCEEDED(range->GetAttributeValue(UIA_IsReadOnlyAttributeId, &readOnly)) && readOnly.vt == VT_BOOL;
        bool editable = known && readOnly.boolVal == VARIANT_FALSE;
        VariantClear(&readOnly);
        if (known) return editable;
    }
    ComPtr<IUIAutomationValuePattern> value;
    BOOL readOnly = TRUE;
    CONTROLTYPEID kind = 0;
    return SUCCEEDED(element->get_CurrentControlType(&kind)) && kind == UIA_EditControlTypeId &&
        SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) &&
        SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly;
}

static Target capture(IUIAutomation* automation, DWORD appPid) {
    Target target;
    target.foreground = GetForegroundWindow();
    const DWORD thread = GetWindowThreadProcessId(target.foreground, &target.process);
    if (!thread || !target.process || target.process == appPid) return {};
    target.focus = focusedWindow(thread);
    if (captureNativeEdit(target)) return target;

    BOOL enabled = FALSE, password = TRUE;
    if (!automation || FAILED(automation->GetFocusedElement(&target.element)) || !target.element ||
        FAILED(target.element->get_CurrentIsEnabled(&enabled)) || !enabled ||
        FAILED(target.element->get_CurrentIsPassword(&password)) || password) return {};
    target.selection = selectionOf(target.element.Get());
    if (!writable(target.element.Get(), target.selection.Get())) return {};
    return target;
}

static bool sameCaret(IUIAutomation* automation, const Target& saved, const Target& current) {
    if (!saved.foreground || saved.foreground != current.foreground ||
        saved.process != current.process || saved.focus != current.focus) return false;
    if (saved.nativeEdit && current.nativeEdit)
        return saved.selectionStart == current.selectionStart && saved.selectionEnd == current.selectionEnd;
    if (!automation || !saved.element || !current.element || !saved.selection || !current.selection) return false;

    BOOL sameElement = FALSE;
    int starts = 0, ends = 0;
    return SUCCEEDED(automation->CompareElements(saved.element.Get(), current.element.Get(), &sameElement)) &&
        sameElement &&
        SUCCEEDED(saved.selection->CompareEndpoints(TextPatternRangeEndpoint_Start, current.selection.Get(), TextPatternRangeEndpoint_Start, &starts)) &&
        SUCCEEDED(saved.selection->CompareEndpoints(TextPatternRangeEndpoint_End, current.selection.Get(), TextPatternRangeEndpoint_End, &ends)) &&
        starts == 0 && ends == 0;
}

static bool modifiersDown() {
    for (int key : {VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN}) {
        if (GetAsyncKeyState(key) & 0x8000) return true;
    }
    return false;
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

static const char* insertText(IUIAutomation* automation, DWORD appPid, const Target* saved, const std::wstring& text) {
    if (text.empty()) return "unavailable";
    for (int attempt = 0; attempt < 30 && modifiersDown(); ++attempt) Sleep(10);
    if (modifiersDown()) return "unavailable";

    Target current = capture(automation, appPid);
    if (!current.foreground || (saved && !sameCaret(automation, *saved, current))) return "moved";
    std::vector<INPUT> input;
    input.reserve(text.size() * 2);
    for (const wchar_t character : text) {
        INPUT item{};
        item.type = INPUT_KEYBOARD;
        item.ki.wScan = character;
        item.ki.dwFlags = KEYEVENTF_UNICODE;
        input.push_back(item);
        item.ki.dwFlags |= KEYEVENTF_KEYUP;
        input.push_back(item);
    }
    const DWORD thread = GetWindowThreadProcessId(current.foreground, nullptr);
    if (GetForegroundWindow() != current.foreground || focusedWindow(thread) != current.focus || modifiersDown()) return "moved";
    const UINT sent = SendInput(static_cast<UINT>(input.size()), input.data(), sizeof(INPUT));
    if (sent == input.size()) return "written";
    return sent ? "partial" : "unavailable";
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
        std::string command;
        while (std::getline(std::cin, command)) {
            const char* response = "unavailable";
            if (command == "capture") {
                saved = capture(automation.Get(), appPid);
                response = (saved.nativeEdit || saved.selection) ? "captured" : "unavailable";
            } else if (command == "clear") {
                saved = {};
                response = "ok";
            } else if (command.rfind("insert ", 0) == 0) {
                response = insertText(automation.Get(), appPid, &saved, decodeText(command.substr(7)));
                saved = {};
            } else if (command.rfind("current ", 0) == 0) {
                response = insertText(automation.Get(), appPid, nullptr, decodeText(command.substr(8)));
                saved = {};
            }
            std::cout << response << std::endl;
        }
    }
    CoUninitialize();
}
