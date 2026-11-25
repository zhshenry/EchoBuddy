# Bundled offline dictation components

EchoBuddy uses SenseVoiceSmall INT8 ONNX, bilingual Zipformer INT8 ONNX, Silero VAD, CAM++, pyannote segmentation 3.0, and sherpa-onnx-node 1.13.8.
The original model names, authors and separate license texts are retained here.

- SenseVoiceSmall: Alibaba Group / FunAudioLLM (QwenAudio).
  https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- ONNX conversion: csukuangfj / next-gen Kaldi.
  Revision 2365baeacb507f821a0c8120fcee3d484dba7a07:
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
  Its LICENSE points to FunASR's separate model license; source-code MIT is not substituted for the weight license.
- Silero VAD: Silero Team.
  https://github.com/snakers4/silero-vad
  Model revision fba88cd2e921609e7675c3aaf51e0b9b295da4bc:
  https://huggingface.co/csukuangfj/vad
- CAM++ speaker embedding (Chinese 16 kHz common): ModelScope / 3D-Speaker, Apache-2.0.
  https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common
  The bundled ONNX conversion is from the sherpa-onnx speaker recognition release.
- pyannote segmentation 3.0: pyannote.audio / Séverin Baroudi, MIT.
  https://huggingface.co/pyannote/segmentation-3.0
  The bundle uses csukuangfj's ONNX conversion at revision 9403a6902bb58e3d5ae8c7e77c3422de279db2e0.
  https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0
- sherpa-onnx: next-gen Kaldi team, Apache-2.0.
  https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8
- The bilingual Chinese-English Zipformer Transducer export by csukuangfj / next-gen Kaldi uses Apache-2.0. The full text is in sherpa-onnx-Apache-2.0.txt.
  https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/tree/98590b7ed6443e77b714204da2757d75e1a642f4
- ONNX Runtime: Microsoft, MIT.
  The Windows native package reports ONNX Runtime 1.28.2.
  https://github.com/microsoft/onnxruntime
- The recognition segmentation approach is adapted from DeepSeek Harness rc.2 (MIT), Copyright (c) 2026 DeepSeek.
  https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2

Model file hashes and immutable download URLs are recorded in the sibling manifest.json.
These notices accompany every installer.
