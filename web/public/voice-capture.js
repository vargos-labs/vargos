// The AudioContext resamples capture to 16 kHz before this processor runs.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(320);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.chunk[this.offset++] = sample;
      if (this.offset === this.chunk.length) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(320);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
