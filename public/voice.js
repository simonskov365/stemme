/** Local silence detection; no browser/cloud speech recognition service is used. */
export class SpeechGate {
  constructor() {
    this.reset();
  }
  reset(now = 0) {
    this.started = now;
    this.lastVoice = now;
    this.voicedMs = 0;
    this.previous = now;
    this.heard = false;
  }
  sample(level, now) {
    const elapsed = Math.max(0, Math.min(100, now - this.previous));
    this.previous = now;
    if (level > 0.018) {
      this.voicedMs += elapsed;
      this.lastVoice = now;
      if (this.voicedMs >= 220) this.heard = true;
    }
    if (this.heard && now - this.lastVoice > 950) return "send";
    if (this.heard && now - this.started >= 60000) return "send";
    if (!this.heard && now - this.started >= 20000) return "discard";
    return "continue";
  }
}
export class ConversationVoice {
  constructor(options) {
    this.options = options;
    this.enabled = false;
    this.phase = "off";
    this.epoch = 0;
    this.captureId = 0;
    this.operation = 0;
    this.timer = null;
    this.stream = null;
    this.context = null;
    this.capture = null;
    this.upload = null;
  }
  state(phase) {
    this.phase = phase;
    this.options.onState(phase);
  }
  async start() {
    if (this.enabled) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      !window.MediaRecorder ||
      !(window.AudioContext || window.webkitAudioContext)
    )
      throw new Error(
        "Din browser understøtter ikke mikrofonoptagelse. Prøv en opdateret Safari eller Chrome.",
      );
    this.enabled = true;
    const epoch = ++this.epoch;
    this.state("permission");
    let stream, context;
    try {
      context = new (window.AudioContext || window.webkitAudioContext)();
      this.context = context;
      // Request permission in the click gesture; Safari resume() may stay pending until capture is allowed.
      void context.resume().catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!this.enabled || epoch !== this.epoch) {
        stream.getTracks().forEach((t) => t.stop());
        await context.close().catch(() => {});
        return;
      }
      this.stream = stream;
      if (context.state !== "running") {
        const resume = context.resume();
        let timeout;
        try {
          await Promise.race([
            resume,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("AUDIO_SUSPENDED")),
                4000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        if (context.state !== "running") throw new Error("AUDIO_SUSPENDED");
      }
      stream.getTracks().forEach((t) => {
        t.enabled = false;
        t.addEventListener("ended", () => {
          if (this.enabled && epoch === this.epoch)
            this.fail(
              "Mikrofonen blev afbrudt. Start samtalen igen, når den er tilsluttet.",
            );
        });
      });
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(this.analyser);
      // Safari needs an active output graph; zero gain prevents microphone monitoring/feedback.
      const silent = context.createGain();
      silent.gain.value = 0;
      this.analyser.connect(silent);
      silent.connect(context.destination);
      this.samples = new Float32Array(1024);
      this.state("waiting");
      this.update();
    } catch (e) {
      if (this.enabled && epoch === this.epoch)
        this.fail(
          e?.message === "AUDIO_SUSPENDED"
            ? "Safari har sat lydsystemet på pause. Klik Start samtale igen. Tillad også automatisk afspilning for denne side i Safari."
            : ({
                NotAllowedError:
                  "Mikrofonadgang blev afvist. Tillad mikrofonen for denne side i Safari/Chrome og i macOS > Anonymitet og sikkerhed > Mikrofon.",
                NotFoundError:
                  "Der blev ikke fundet en mikrofon. Vælg en mikrofon under macOS > Lyd > Indgang.",
                NotReadableError:
                  "Mikrofonen kunne ikke åbnes. Luk andre optageapps, og prøv igen.",
              }[e?.name] ??
                "Mikrofonen kunne ikke starte. Kontrollér adgang og din valgte mikrofon."),
        );
      else {
        stream?.getTracks().forEach((t) => t.stop());
        void context?.close().catch(() => {});
      }
    }
  }
  update() {
    if (
      !this.enabled ||
      !this.stream ||
      ["permission", "transcribing", "sending"].includes(this.phase)
    )
      return;
    if (this.options.isBusy()) {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.capture) this.finish(false);
      this.stream.getTracks().forEach((t) => (t.enabled = false));
      this.state("waiting");
      return;
    }
    if (this.capture || this.timer) return;
    this.state("waiting");
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.enabled && !this.options.isBusy()) this.arm();
    }, 450);
  }
  arm() {
    if (!this.enabled || this.options.isBusy() || this.capture) return;
    try {
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      if (!type) throw new Error("Optageformatet understøttes ikke.");
      this.stream.getTracks().forEach((t) => (t.enabled = true));
      const recorder = new MediaRecorder(this.stream, { mimeType: type }),
        epoch = this.epoch,
        id = ++this.captureId,
        chunks = [];
      const capture = { recorder, id, epoch, chunks, type, send: false };
      this.capture = capture;
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => {
        if (this.enabled && epoch === this.epoch)
          this.fail("Lydoptagelsen blev afbrudt. Start samtalen igen.");
      };
      recorder.onstop = () => {
        if (capture.send && this.enabled && epoch === this.epoch)
          void this.transcribe(new Blob(chunks, { type }), epoch);
      };
      recorder.start(200);
      this.state("listening");
      const gate = new SpeechGate();
      gate.reset(performance.now());
      const check = () => {
        if (!this.enabled || this.capture !== capture) return;
        this.analyser.getFloatTimeDomainData(this.samples);
        const rms = Math.sqrt(
          this.samples.reduce((sum, n) => sum + n * n, 0) / this.samples.length,
        );
        this.options.onLevel(Math.min(1, rms * 8));
        const result = gate.sample(rms, performance.now());
        if (result === "send") {
          this.finish(true);
          return;
        }
        if (result === "discard") {
          this.finish(false);
          this.state("waiting");
          this.update();
          return;
        }
        this.frame = requestAnimationFrame(check);
      };
      this.frame = requestAnimationFrame(check);
    } catch {
      this.fail(
        "Browseren kunne ikke optage lyd. Prøv en opdateret Safari eller Chrome.",
      );
    }
  }
  finish(send) {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    capture.send = send;
    cancelAnimationFrame(this.frame);
    this.options.onLevel(0);
    this.stream?.getTracks().forEach((t) => (t.enabled = false));
    if (send) this.state("transcribing");
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
  }
  sendNow() {
    if (this.enabled && this.capture) this.finish(true);
  }
  async transcribe(blob, epoch) {
    if (!blob.size) {
      this.fail("Optagelsen var tom. Start samtalen igen.");
      return;
    }
    if (blob.size > 8 * 1024 * 1024) {
      this.fail("Optagelsen var for stor. Prøv en kortere besked.");
      return;
    }
    const operation = ++this.operation;
    this.upload = new AbortController();
    try {
      const text = await this.options.transcribe(
        blob,
        crypto.randomUUID(),
        this.upload.signal,
      );
      if (!this.enabled || epoch !== this.epoch || operation !== this.operation)
        return;
      this.state("sending");
      await this.options.onTranscript(text);
      if (!this.enabled || epoch !== this.epoch || operation !== this.operation)
        return;
      this.state("waiting");
      this.update();
    } catch (e) {
      if (this.enabled && epoch === this.epoch && operation === this.operation)
        this.fail(e?.message ?? "Talen kunne ikke genkendes. Prøv igen.");
    }
  }
  interrupt() {
    if (!this.enabled) return;
    this.operation++;
    this.upload?.abort();
    if (this.capture) this.finish(false);
    this.state("waiting");
    this.options.interrupt();
    this.update();
  }
  fail(message) {
    this.stop();
    this.options.onError(message);
  }
  stop() {
    this.enabled = false;
    this.epoch++;
    this.operation++;
    clearTimeout(this.timer);
    this.timer = null;
    this.upload?.abort();
    this.finish(false);
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.context && this.context.state !== "closed")
      void this.context.close().catch(() => {});
    this.context = null;
    this.options.onLevel(0);
    this.state("off");
  }
}
