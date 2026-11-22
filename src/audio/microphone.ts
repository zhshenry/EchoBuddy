import { SPEECH_SAMPLE_RATE } from '../../shared/speech-contracts';

export class Microphone {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private flush?: () => void;
  private stopped?: Promise<void>;

  constructor(
    private readonly accept: (samples: Float32Array) => void,
    private readonly ended: () => void,
    private readonly speechProcessing = true,
  ) {}

  async start(): Promise<void> {
    const context = this.context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
    await Promise.all([context.resume(), context.audioWorklet.addModule(new URL('./voice-frames.js', window.location.href))]);
    if (this.stopped) return;

    const worklet = this.worklet = new AudioWorkletNode(context, 'voice-frames');
    worklet.port.onmessage = ({ data }) => {
      if (data === 'end') this.flush?.();
      else this.accept(data);
    };
    const mute = context.createGain();
    mute.gain.value = 0;
    worklet.connect(mute).connect(context.destination);
    // Have the capture graph ready when the microphone starts delivering samples.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: this.speechProcessing, noiseSuppression: this.speechProcessing },
      video: false,
    });
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.onended = this.ended;
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(worklet);
  }

  stop(): Promise<void> {
    return this.stopped ??= this.disconnect();
  }

  private async disconnect(): Promise<void> {
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (this.worklet && this.context?.state === 'running') {
      await new Promise<void>(resolve => {
        const timer = window.setTimeout(resolve, 200);
        this.flush = () => { window.clearTimeout(timer); resolve(); };
        this.worklet!.port.postMessage('end');
      });
      this.worklet.port.onmessage = null;
      this.flush = undefined;
    }
    this.worklet?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
