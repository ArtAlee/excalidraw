import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { api } from "./api";
import { mergeElements } from "./mergeElements.mjs";

export type SyncedScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

const fingerprint = (scene: SyncedScene) =>
  JSON.stringify({
    elements: scene.elements
      .map(({ id, version, versionNonce }) => [id, version, versionNonce])
      .sort(),
    appState: Object.entries(scene.appState).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    files: Object.entries(scene.files)
      .map(([id, file]) => [id, file.dataURL])
      .sort(),
  });
const stateChanges = (
  current: Partial<AppState>,
  baseline: Partial<AppState>,
) =>
  Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(baseline[key as keyof AppState]),
    ),
  );

/** One serialized stream for local saves and remote updates. */
export class BoardSync {
  private latest: SyncedScene;
  private saved: SyncedScene;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private realtime = false;
  private remotePending = false;
  private scheduledWrite = false;

  setRealtime(active: boolean) {
    this.realtime = active;
    this.schedule();
  }

  remoteChanged() {
    this.remotePending = true;
    // Remote notifications must not bypass the drawing throttle.
    if (!this.running && !this.dirty) {
      this.flush(false).catch(() => {});
    }
  }

  constructor(
    private path: string,
    scene: SyncedScene,
    private revision: number,
    private apply: (scene: SyncedScene) => void,
    private notify: (state: string, error?: unknown) => void,
  ) {
    this.latest = scene;
    this.saved = scene;
  }

  get dirty() {
    return fingerprint(this.latest) !== fingerprint(this.saved);
  }

  set(scene: SyncedScene) {
    this.latest = scene;
    if (this.dirty) {
      this.notify("pending");
      if (this.realtime && !this.scheduledWrite && !this.running) {
        this.schedule();
      }
    }
  }

  start() {
    this.active = true;
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.active) {
      this.scheduledWrite = this.dirty;
      this.timer = setTimeout(
        () => {
          this.flush(false).catch(() => {});
        },
        this.realtime ? (this.dirty ? 100 : 15000) : 750,
      );
    }
  }

  async flush(drain = true): Promise<void> {
    if (this.running) {
      await this.running;
      // Explicit save/navigation must also drain edits made during that request.
      if ((drain && this.dirty) || (this.remotePending && !this.dirty)) {
        return this.flush(drain);
      }
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remotePending = false;
    this.running = this.sync();
    try {
      await this.running;
    } finally {
      this.running = null;
      this.schedule();
    }
    if (
      ((this.remotePending && !this.dirty) || (drain && this.dirty)) &&
      this.active
    ) {
      return this.flush(drain);
    }
  }

  private async sync() {
    const snapshot = this.latest;
    const writing = this.dirty;
    if (writing) {
      this.notify("saving");
    }
    const savedElements = new Map(
      this.saved.elements.map((element) => [element.id, element]),
    );
    try {
      const next = await api<{ revision: number; scene?: SyncedScene }>(
        writing ? this.path : `${this.path}?revision=${this.revision}`,
        writing ? "PUT" : "GET",
        writing
          ? {
              scene: {
                ...snapshot,
                elements: snapshot.elements.filter((element) => {
                  const previous = savedElements.get(element.id);
                  return (
                    !previous ||
                    previous.version !== element.version ||
                    previous.versionNonce !== element.versionNonce
                  );
                }),
                files: Object.fromEntries(
                  Object.entries(snapshot.files).filter(
                    ([id, file]) =>
                      this.saved.files[id]?.dataURL !== file.dataURL,
                  ),
                ),
                appState: stateChanges(snapshot.appState, this.saved.appState),
              },
            }
          : undefined,
      );
      if (!this.active) {
        return;
      }
      this.revision = next.revision;
      if (next.scene) {
        const localState = stateChanges(
          this.latest.appState,
          snapshot.appState,
        );
        this.saved = next.scene;
        this.latest = {
          elements: mergeElements(this.latest.elements, next.scene.elements),
          // Keep the participant's viewport and UI state local.
          appState: { ...next.scene.appState, ...localState },
          files: { ...next.scene.files, ...this.latest.files },
        };
        this.apply(this.latest);
      }
      this.notify(this.dirty ? "pending" : "saved");
    } catch (error) {
      if (this.active) {
        this.notify("error", error);
      }
      throw error;
    }
  }

  dispose() {
    this.active = false;
    clearTimeout(this.timer);
  }
}
