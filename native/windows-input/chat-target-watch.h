#pragma once

#include <Windows.h>
#include <atomic>
#include <future>
#include <thread>
#include <utility>

struct DictationShortcut {
    DWORD key = 0;
    UINT modifiers = 0;
};

inline constexpr ULONG_PTR dictationInputTag = 0x45425544;

// Track intervening input for guarded pastes and streaming writes.
class ChatTargetWatch {
public:
    ~ChatTargetWatch() { stop(); }

    void start(HWND foreground, DWORD appPid, DictationShortcut shortcut) {
        foreground_ = foreground;
        appPid_ = appPid;
        shortcut_ = shortcut;
        changed_ = false;
        std::promise<DWORD> ready;
        auto started = ready.get_future();
        worker_ = std::thread([this, ready = std::move(ready)]() mutable {
            active_ = this;
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            MSG message{};
            PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
            const HINSTANCE module = GetModuleHandleW(nullptr);
            const HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardEvent, module, 0);
            for (auto& modifier : modifiers_)
                modifier.down = (GetAsyncKeyState(modifier.key) & 0x8000) != 0;
            const HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, mouseEvent, module, 0);
            const HWINEVENTHOOK focus = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                nullptr, foregroundEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
            DWORD process = 0;
            GetWindowThreadProcessId(foreground_, &process);
            const HWINEVENTHOOK editorFocus = process ? SetWinEventHook(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS,
                nullptr, editorFocusEvent, process, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS) : nullptr;
            editorChanged_ = !editorFocus;
            const bool installed = keyboard && mouse && focus && GetForegroundWindow() == foreground_;
            ready.set_value(installed ? GetCurrentThreadId() : 0);
            if (installed) {
                while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
            }
            changed_ = true;
            if (editorFocus) UnhookWinEvent(editorFocus);
            if (focus) UnhookWinEvent(focus);
            if (mouse) UnhookWindowsHookEx(mouse);
            if (keyboard) UnhookWindowsHookEx(keyboard);
        });
        threadId_ = started.get();
        if (!threadId_) worker_.join();
    }

    void stop() {
        if (!worker_.joinable()) return;
        PostThreadMessageW(threadId_, WM_QUIT, 0, 0);
        worker_.join();
        threadId_ = 0;
    }

    bool watching() const { return threadId_ != 0; }
    bool unchanged() const { return !changed_; }
    bool editorUnchanged() const { return watching() && unchanged() && !editorChanged_; }

private:
    void keyEvent(DWORD key, bool down) {
        if (key == VK_CONTROL) key = VK_LCONTROL;
        if (key == VK_MENU) key = VK_LMENU;
        if (key == VK_SHIFT) key = VK_LSHIFT;
        UINT modifiers = 0;
        for (auto& modifier : modifiers_) {
            if (modifier.key == key) {
                modifier.down = down;
                return;
            }
            if (modifier.down) modifiers |= modifier.mask;
        }
        if (down && (key != shortcut_.key || modifiers != shortcut_.modifiers)) changed_ = true;
    }

    static LRESULT CALLBACK keyboardEvent(int code, WPARAM event, LPARAM data) {
        if (code == HC_ACTION) {
            const auto* key = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
            if (!(key->flags & LLKHF_INJECTED) || key->dwExtraInfo != dictationInputTag)
                active_->keyEvent(key->vkCode, event == WM_KEYDOWN || event == WM_SYSKEYDOWN);
        }
        return CallNextHookEx(nullptr, code, event, data);
    }

    static LRESULT CALLBACK mouseEvent(int code, WPARAM event, LPARAM data) {
        if (code == HC_ACTION && event != WM_MOUSEMOVE) {
            const auto* input = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
            DWORD pid = 0;
            GetWindowThreadProcessId(GetAncestor(WindowFromPoint(input->pt), GA_ROOT), &pid);
            if (pid != active_->appPid_) active_->changed_ = true;
        }
        return CallNextHookEx(nullptr, code, event, data);
    }

    static void CALLBACK foregroundEvent(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
        if (window != active_->foreground_) active_->changed_ = true;
    }

    static void CALLBACK editorFocusEvent(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
        if (!window || GetAncestor(window, GA_ROOT) == active_->foreground_) active_->editorChanged_ = true;
    }

    inline static thread_local ChatTargetWatch* active_ = nullptr;
    struct Modifier { DWORD key; UINT mask; bool down; };
    Modifier modifiers_[8] = {
        {VK_LCONTROL, MOD_CONTROL, false}, {VK_RCONTROL, MOD_CONTROL, false},
        {VK_LMENU, MOD_ALT, false}, {VK_RMENU, MOD_ALT, false},
        {VK_LSHIFT, MOD_SHIFT, false}, {VK_RSHIFT, MOD_SHIFT, false},
        {VK_LWIN, MOD_WIN, false}, {VK_RWIN, MOD_WIN, false},
    };
    std::atomic_bool changed_{true};
    std::atomic_bool editorChanged_{true};
    std::thread worker_;
    DWORD threadId_ = 0;
    HWND foreground_ = nullptr;
    DWORD appPid_ = 0;
    DictationShortcut shortcut_;
};
