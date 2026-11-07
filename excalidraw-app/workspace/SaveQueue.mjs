/** Serializes writes and preserves the newest unsaved snapshot on failure. */
export class SaveQueue {
  constructor(initial, revision, save, notify) {
    this.saved = initial;
    this.latest = initial;
    this.revision = revision;
    this.save = save;
    this.notify = notify;
    this.running = null;
    this.timer = null;
    this.error = null;
  }
  get dirty() {
    return this.latest !== this.saved;
  }
  set(snapshot) {
    this.latest = snapshot;
    clearTimeout(this.timer);
    if (this.dirty) {
      this.notify(this.error ? "error" : "pending", this.error);
      if (!this.error) {
        this.timer = setTimeout(() => {
          this.flush().catch(() => {});
        }, 750);
      }
    } else if (!this.running) {
      this.notify("saved", null);
    }
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.running) {
      return this.running;
    }
    this.error = null;
    this.running = (async () => {
      while (this.dirty) {
        const snapshot = this.latest;
        this.notify("saving", null);
        try {
          this.revision = await this.save(snapshot, this.revision);
          this.saved = snapshot;
        } catch (error) {
          this.error = error;
          this.notify("error", error);
          throw error;
        }
      }
      this.notify("saved", null);
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
