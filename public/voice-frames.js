// The AudioContext resamples both the microphone and the sample to 16 kHz.
class VoiceFrames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.used = 0;
    this.ended = false;
    this.port.onmessage = () => {
      this.ended = true;
      if (this.used) this.port.postMessage(this.block.slice(0, this.used));
      this.port.postMessage('end');
    };
  }
  process(inputs) {
    if (this.ended) return false;
    const channel = inputs[0][0];
    if (!channel) return true;
    for (let start = 0; start < channel.length;) {
      const count = Math.min(channel.length - start, this.block.length - this.used);
      this.block.set(channel.subarray(start, start + count), this.used);
      start += count;
      this.used += count;
      if (this.used === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-frames', VoiceFrames);
