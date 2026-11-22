#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>

using Microsoft::WRL::ComPtr;

constexpr UINT32 rate = 16000;
constexpr UINT32 maxFrames = 2 * 60 * 60 * rate;
constexpr std::uint64_t ticksPerSecond = 10000000;

std::uint64_t clockTicks() {
  static const auto frequency = [] {
    LARGE_INTEGER value{};
    QueryPerformanceFrequency(&value);
    return static_cast<std::uint64_t>(value.QuadPart);
  }();
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  const auto ticks = static_cast<std::uint64_t>(value.QuadPart);
  return ticks / frequency * ticksPerSecond + ticks % frequency * ticksPerSecond / frequency;
}

UINT32 framesBetween(std::uint64_t start, std::uint64_t end) {
  if (end <= start) return 0;
  return static_cast<UINT32>(std::min<std::uint64_t>(maxFrames, (end - start) * rate / ticksPerSecond));
}

struct WaveHeader {
  char riff[4] = {'R','I','F','F'};
  uint32_t riffSize = 36;
  char wave[4] = {'W','A','V','E'};
  char format[4] = {'f','m','t',' '};
  uint32_t formatSize = 16;
  uint16_t encoding = 1, channels = 1;
  uint32_t sampleRate = rate, byteRate = rate * 2;
  uint16_t blockAlign = 2, bits = 16;
  char data[4] = {'d','a','t','a'};
  uint32_t dataSize = 0;
};
static_assert(sizeof(WaveHeader) == 44);

class WaveFile {
 public:
  ~WaveFile() { if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_); }

  bool open(const std::wstring& path) {
    file_ = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    const WaveHeader header;
    return file_ != INVALID_HANDLE_VALUE && write(&header, sizeof(header));
  }

  bool append(UINT32 offset, const BYTE* bytes, UINT32 count) {
    // Adjacent packets can differ by a few samples after clock conversion.
    if (offset >= frames_ ? offset - frames_ < rate / 100 : frames_ - offset < rate / 100) offset = frames_;
    if (!pad(offset)) return false;
    const UINT32 overlap = frames_ - offset;
    if (overlap >= count || frames_ == maxFrames) return true;
    const UINT32 remaining = std::min(count - overlap, maxFrames - frames_);
    if (!bytes) return pad(frames_ + remaining);
    if (!write(bytes + overlap * 2, remaining * 2)) return false;
    frames_ += remaining;
    return true;
  }

  bool pad(UINT32 end) {
    static constexpr std::array<std::int16_t, 8192> silence{};
    while (frames_ < end) {
      const auto count = std::min<UINT32>(end - frames_, static_cast<UINT32>(silence.size()));
      if (!write(silence.data(), count * 2)) return false;
      frames_ += count;
    }
    return true;
  }

  bool checkpoint() {
    WaveHeader header;
    header.dataSize = frames_ * 2;
    header.riffSize += header.dataSize;
    LARGE_INTEGER zero{}, end{};
    end.QuadPart = sizeof(header) + header.dataSize;
    return SetFilePointerEx(file_, zero, nullptr, FILE_BEGIN) && write(&header, sizeof(header))
      && SetFilePointerEx(file_, end, nullptr, FILE_BEGIN) && FlushFileBuffers(file_);
  }

 private:
  bool write(const void* data, DWORD size) {
    DWORD written{};
    return WriteFile(file_, data, size, &written, nullptr) && written == size;
  }

  HANDLE file_ = INVALID_HANDLE_VALUE;
  UINT32 frames_ = 0;
};

class Track {
 public:
  Track(const char* name, const wchar_t* filename, EDataFlow flow, ERole role)
    : name(name), filename_(filename), flow_(flow), role_(role) {}

  bool initialize(IMMDeviceEnumerator* devices) {
    if (FAILED(devices->GetDefaultAudioEndpoint(flow_, role_, &device_)) ||
        FAILED(device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client_))) return false;
    const WAVEFORMATEX format{WAVE_FORMAT_PCM, 1, rate, rate * 2, 2, 16, 0};
    DWORD flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if (flow_ == eRender) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    return SUCCEEDED(client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, &format, nullptr))
      && SUCCEEDED(client_->GetService(IID_PPV_ARGS(&capture_)));
  }

  bool open(const std::wstring& directory) { return file.open(directory + L"\\" + filename_); }
  bool start() { return active = SUCCEEDED(client_->Start()); }
  bool deviceActive() const {
    DWORD state{};
    return SUCCEEDED(device_->GetState(&state)) && (state & DEVICE_STATE_ACTIVE);
  }

  bool drain(std::uint64_t origin, UINT32 limit) {
    UINT32 next{};
    HRESULT hr = capture_->GetNextPacketSize(&next);
    while (SUCCEEDED(hr) && next) {
      BYTE* bytes{};
      UINT32 count{};
      DWORD flags{};
      UINT64 timestamp{};
      hr = capture_->GetBuffer(&bytes, &count, &flags, nullptr, &timestamp);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) return true;
      if (FAILED(hr)) break;
      const auto offset = !timestamp || (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)
        ? (limit > count ? limit - count : 0) : std::min(framesBetween(origin, timestamp), limit);
      const auto available = std::min(count, limit - offset);
      const bool saved = file.append(offset, (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : bytes, available);
      hr = capture_->ReleaseBuffer(count);
      if (!saved) return false;
      if (FAILED(hr)) break;
      hr = capture_->GetNextPacketSize(&next);
    }
    if (FAILED(hr)) disconnect();
    return true;
  }

  void disconnect() {
    if (!active) return;
    active = false;
    client_->Stop();
    std::printf("warning %s\n", name);
  }

  const char* name;
  WaveFile file;
  bool active = false;

 private:
  const wchar_t* filename_;
  EDataFlow flow_;
  ERole role_;
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioCaptureClient> capture_;
};

bool stopping() {
  return !PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, nullptr, nullptr);
}

int record(const std::wstring& directory, bool microphone, bool system) {
  ComPtr<IMMDeviceEnumerator> devices;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices)))) {
    std::puts("error device"); return 1;
  }
  Track mic("microphone", L"microphone.wav", eCapture, eConsole);
  Track loopback("system", L"system.wav", eRender, eConsole);
  const std::array<Track*, 2> tracks{microphone ? &mic : nullptr, system ? &loopback : nullptr};
  for (auto* track : tracks) {
    if (track && !track->initialize(devices.Get())) { std::printf("error %s\n", track->name); return 1; }
  }
  if (stopping()) return 0;
  for (auto* track : tracks) {
    if (track && !track->open(directory)) { std::puts("error disk"); return 1; }
  }
  const auto origin = clockTicks();
  for (auto* track : tracks) {
    if (track && !track->start()) { std::printf("error %s\n", track->name); return 1; }
  }
  std::puts("ready");

  auto nextCheckpoint = origin + 5 * ticksPerSecond;
  auto nextDeviceCheck = origin + ticksPerSecond;
  while (true) {
    const auto now = clockTicks();
    const auto elapsed = framesBetween(origin, now);
    const bool stopRequested = stopping() || elapsed == maxFrames;
    const bool checkDevice = now >= nextDeviceCheck;
    bool anyActive = false;
    for (auto* track : tracks) {
      if (!track || !track->active) continue;
      if (!track->drain(origin, elapsed)) { std::puts("error disk"); return 1; }
      if (checkDevice && !track->deviceActive()) track->disconnect();
      anyActive |= track->active;
    }
    if (checkDevice) nextDeviceCheck = now + ticksPerSecond;
    const bool finish = stopRequested || !anyActive;
    const bool checkpoint = finish || now >= nextCheckpoint;
    if (checkDevice || checkpoint) {
      // Leave time for queued device packets when a source has gone quiet.
      const UINT32 end = finish ? elapsed : (elapsed > rate / 2 ? elapsed - rate / 2 : 0);
      for (auto* track : tracks) {
        if (track && (!track->file.pad(end) || (checkpoint && !track->file.checkpoint()))) { std::puts("error disk"); return 1; }
      }
      if (finish) return 0;
      if (checkpoint) nextCheckpoint = now + 5 * ticksPerSecond;
    }
    Sleep(12);
  }
}

int wmain(int argc, wchar_t** argv) {
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  if (argc != 3 || (std::wcscmp(argv[2], L"microphone") && std::wcscmp(argv[2], L"system") && std::wcscmp(argv[2], L"both"))) return 1;
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { std::puts("error device"); return 1; }
  const int result = record(argv[1], std::wcscmp(argv[2], L"system") != 0, std::wcscmp(argv[2], L"microphone") != 0);
  CoUninitialize();
  return result;
}
