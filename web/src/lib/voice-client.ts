import type { VoiceActivity } from "@vargos/lib/voice";

export interface VoiceCallbacks {
  session?: (sessionKey: string) => void;
  status: (text: string) => void;
  transcript: (role: 'You' | 'Vargos' | 'Progress', text: string) => void;
  level: (value: number) => void;
  outputLevel: (value: number) => void;
  activity: (activity: VoiceActivity) => void;
  error: (message: string) => void;
  closed: () => void;
}

/** Browser-owned audio resources. stop() also handles partial/aborted startup. */
export class VoiceClient {
  private socket: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sources = new Map<AudioBufferSourceNode, { itemId: string; start: number; duration: number }>();
  private playback = new Map<string, { contentIndex: number; played: number; total: number; complete: boolean }>();
  private nextAudio = 0;
  private outputRate = 16000;
  private ready = false;
  private stopped = false;
  private muted = false;
  private paused = false;
  private phase = 'Listening';
  private discardAudio = false;
  private lastOutputLevel = 0;
  private assistant = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private levelAt = 0;

  constructor(private callbacks: VoiceCallbacks) {}

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS and a supported browser.');
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.stopped) { this.stream.getTracks().forEach(t => t.stop()); return; }
      const url = new URL(process.env.NEXT_PUBLIC_VARGOS_WS_URL || window.location.origin);
      if (!process.env.NEXT_PUBLIC_VARGOS_WS_URL) {
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.port = process.env.NEXT_PUBLIC_VARGOS_WS_PORT || '9004';
      }
      // HTTPS voice traffic stays on the console's authenticated origin.
      if (window.location.protocol === 'https:') {
        url.protocol = 'wss:';
        url.host = window.location.host;
        if (!process.env.NEXT_PUBLIC_VARGOS_WS_URL) url.pathname = '/ws';
      }
      url.searchParams.set('voice', '1');
      const socket = new WebSocket(url);
      this.socket = socket;
      this.timer = setTimeout(() => this.fail('Voice connection timed out.'), 15000);
      socket.onerror = () => this.fail('Unable to connect to the voice service.');
      socket.onclose = () => this.stop();
      socket.onmessage = message => {
        try { this.event(JSON.parse(String(message.data)) as Record<string, unknown>); }
        catch { this.fail('Invalid voice response.'); }
      };
      await this.context.audioWorklet.addModule('/voice-capture.js');
      if (this.stopped) return;
      this.capture = new AudioWorkletNode(this.context, 'voice-capture');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.capture);
      // Keep the capture node processing without routing the microphone to speakers.
      const silent = this.context.createGain();
      silent.gain.value = 0;
      this.capture.connect(silent).connect(this.context.destination);
      this.capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (this.stopped) return;
        const now = performance.now();
        if (now - this.levelAt > 80) {
          this.levelAt = now;
          this.callbacks.level(this.muted || this.paused ? 0 : Math.min(1, Math.sqrt(data.reduce((n, x) => n+x*x, 0)/data.length)*5));
        }
        if (!this.ready || socket.readyState !== WebSocket.OPEN) return;
        const silent = this.muted || this.paused;
        if (socket.bufferedAmount > 128000) { this.fail('The voice connection cannot keep up. Please reconnect.'); return; }
        const bytes = new Uint8Array(data.length*2);
        const view = new DataView(bytes.buffer);
        data.forEach((x, i) => view.setInt16(i*2, silent ? 0 : Math.round(Math.max(-1, Math.min(1, x))*32767), true));
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        this.send({ type: 'input_audio_buffer.append', audio: btoa(binary) });
      };
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted && !this.paused; });
    if (muted) this.callbacks.level(0);
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !paused && !this.muted; });
    try {
      if (paused) {
        // Finish any open utterance before suspending the audio clock.
        if (this.ready) this.send({ type: 'input_audio_buffer.append', audio: btoa('\0'.repeat(32000)) });
        this.callbacks.level(0);
        this.callbacks.outputLevel(0);
        await this.context?.suspend();
      } else {
        await this.context?.resume();
        if (this.sources.size) this.callbacks.outputLevel(this.lastOutputLevel);
      }
      this.refreshStatus();
    } catch { this.fail('Unable to change audio playback state.'); }
  }

  private refreshStatus(): void {
    if (!this.stopped) this.callbacks.status(this.paused ? 'Paused' : this.sources.size ? 'Speaking' : this.phase);
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' });
    this.clearPlayback();
  }

  private clearPlayback(): void {
    this.discardAudio = true;
    const now = this.context?.currentTime || 0;
    for (const [itemId, item] of this.playback) {
      const heard = item.played + [...this.sources.values()].filter(source => source.itemId === itemId)
        .reduce((sum, source) => sum + Math.max(0, Math.min(source.duration, now-source.start)), 0);
      if (heard < item.total) this.send({ type: 'conversation.item.truncate', item_id: itemId,
        content_index: item.contentIndex, audio_end_ms: Math.floor(heard*1000) });
    }
    for (const source of this.sources.keys()) source.stop();
    this.sources.clear();
    this.playback.clear();
    this.nextAudio = 0;
    this.callbacks.outputLevel(0);
    this.phase = 'Listening';
    this.refreshStatus();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.ready = false;
    this.socket?.close();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    for (const source of this.sources.keys()) source.stop();
    this.sources.clear();
    void this.context?.close();
    this.callbacks.level(0);
    this.callbacks.outputLevel(0);
    this.callbacks.closed();
  }

  private fail(message: string): void { this.callbacks.error(message); this.stop(); }
  private send(event: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private event(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === 'voice.session' && typeof event.sessionKey === 'string') {
      this.callbacks.session?.(event.sessionKey);
    } else if (type === 'session.created') {
      const session = event.session as { audio?: { output?: { format?: { rate?: number } } } };
      this.outputRate = session?.audio?.output?.format?.rate || 16000;
    } else if (type === 'session.updated') {
      clearTimeout(this.timer);
      this.ready = true;
      this.refreshStatus();
    } else if (type === 'response.created') {
      this.discardAudio = false;
      this.phase = 'Thinking';
      this.refreshStatus();
    } else if (type === 'input_audio_buffer.speech_started') {
      this.clearPlayback();
      this.phase = 'Hearing you';
      this.refreshStatus();
    } else if (type === 'input_audio_buffer.speech_stopped') {
      this.phase = 'Thinking';
      this.refreshStatus();
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      this.callbacks.transcript('You', String(event.transcript || ''));
    } else if (type === 'voice.progress') {
      this.callbacks.transcript('Progress', String(event.text || ''));
    } else if (type === 'voice.activity') {
      const activity = event.activity as VoiceActivity | undefined;
      if (activity?.id && activity.label) this.callbacks.activity(activity);
    } else if (type === 'response.output_audio_transcript.delta') {
      this.assistant += String(event.delta || '');
    } else if (type === 'response.output_audio_transcript.done') {
      this.callbacks.transcript('Vargos', String(event.transcript || this.assistant));
      this.assistant = '';
    } else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      if (!this.discardAudio && typeof event.item_id === 'string') this.play(event.delta, event.item_id, typeof event.content_index === 'number' ? event.content_index : 0);
    } else if (type === 'response.output_audio.done' && typeof event.item_id === 'string') {
      const item = this.playback.get(event.item_id);
      if (item) {
        item.complete = true;
        if (item.played >= item.total) this.playback.delete(event.item_id);
      }
    } else if (type === 'response.done') {
      const response = event.response as { status?: string; status_details?: unknown };
      if (response?.status === 'failed') { this.fail('The voice response failed. Please reconnect.'); return; }
      this.phase = 'Listening';
      this.refreshStatus();
    } else if (type === 'error') {
      const error = event.error as { message?: string } | undefined;
      this.fail(error?.message || 'Voice service error');
    }
  }

  private play(encoded: string, itemId: string, contentIndex: number): void {
    const context = this.context;
    if (!context || this.stopped) return;
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, Math.floor(bytes.length/2), this.outputRate);
    const samples = buffer.getChannelData(0);
    let energy = 0;
    for (let i=0; i<samples.length; i++) {
      samples[i] = view.getInt16(i*2, true)/32768;
      energy += samples[i]*samples[i];
    }
    this.lastOutputLevel = Math.min(1, Math.sqrt(energy/samples.length)*5);
    if (!this.paused) this.callbacks.outputLevel(this.lastOutputLevel);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.nextAudio = Math.max(context.currentTime + .04, this.nextAudio);
    const item = this.playback.get(itemId) || { contentIndex, played: 0, total: 0, complete: false };
    item.total += buffer.duration;
    this.playback.set(itemId, item);
    this.sources.set(source, { itemId, start: this.nextAudio, duration: buffer.duration });
    source.start(this.nextAudio);
    this.nextAudio += buffer.duration;
    this.refreshStatus();
    source.onended = () => {
      if (this.sources.delete(source)) {
        item.played += buffer.duration;
        if (item.complete && item.played >= item.total) this.playback.delete(itemId);
      }
      if (!this.sources.size && !this.stopped) { this.callbacks.outputLevel(0); this.refreshStatus(); }
    };
  }
}
