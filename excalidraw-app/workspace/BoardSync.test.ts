import { vi, afterEach, expect, test } from "vitest";

import { api } from "./api";
import { BoardSync } from "./BoardSync";

import type { SyncedScene } from "./BoardSync";

vi.mock("./api", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const scene = (ids: string[], version = 1): SyncedScene => ({
  elements: ids.map((id) => ({
    id,
    type: "rectangle",
    version,
    versionNonce: version,
  })) as unknown as SyncedScene["elements"],
  appState: { viewBackgroundColor: "#fff" },
  files: {},
});
const queues: BoardSync[] = [];
const setup = () => {
  const apply = vi.fn();
  const notify = vi.fn();
  const queue = new BoardSync("/public/token", scene([]), 0, apply, notify);
  queues.push(queue);
  queue.start();
  return { queue, apply, notify };
};
afterEach(() => {
  queues.forEach((queue) => queue.dispose());
  queues.length = 0;
  vi.resetAllMocks();
});

test("merges a remote drawing while retaining edits made during a save", async () => {
  const { queue, apply } = setup();
  let release!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  request.mockResolvedValueOnce({
    revision: 2,
    scene: scene(["a", "b", "remote"]),
  });
  queue.set(scene(["a"]));
  const pending = queue.flush();
  queue.set(scene(["a", "b"]));
  release({ revision: 1, scene: scene(["a", "remote"]) });
  await pending;
  expect(request).toHaveBeenCalledTimes(2);
  const outgoing = request.mock.calls[1][2] as { scene: SyncedScene };
  expect(outgoing.scene.elements.map((element) => element.id)).toEqual(["b"]);
  expect(
    apply.mock.lastCall?.[0].elements.map(
      (element: { id: string }) => element.id,
    ),
  ).toEqual(["a", "b", "remote"]);
  expect(queue.dirty).toBe(false);
});

test("remote settings apply without sending a stale background or creating a save loop", async () => {
  const { queue, apply } = setup();
  const remote = {
    ...scene(["remote"]),
    appState: { viewBackgroundColor: "#000" },
  };
  request.mockResolvedValueOnce({ revision: 1, scene: remote });
  await queue.flush();
  expect(apply).toHaveBeenCalledWith(remote);
  expect(queue.dirty).toBe(false);
  queue.set({ ...remote, elements: scene(["remote", "local"]).elements });
  request.mockResolvedValueOnce({
    revision: 2,
    scene: { ...remote, elements: scene(["local", "remote"]).elements },
  });
  await queue.flush();
  expect(request.mock.calls[1][2]).toMatchObject({ scene: { appState: {} } });
  expect(queue.dirty).toBe(false);
});

test("retains unsaved edits after a network failure and retries", async () => {
  const { queue, notify } = setup();
  queue.set(scene(["local"]));
  request.mockRejectedValueOnce(new Error("offline"));
  await expect(queue.flush()).rejects.toThrow("offline");
  expect(queue.dirty).toBe(true);
  expect(notify).toHaveBeenLastCalledWith("error", expect.any(Error));
  request.mockResolvedValueOnce({ revision: 1, scene: scene(["local"]) });
  await queue.flush();
  expect(queue.dirty).toBe(false);
});

test("ignores an in-flight response after the editor unmounts", async () => {
  const { queue, apply } = setup();
  let release!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = queue.flush();
  queue.dispose();
  release({ revision: 1, scene: scene(["remote"]) });
  await pending;
  expect(apply).not.toHaveBeenCalled();
});

test("live saves are throttled, send deltas and do not poll at drawing frequency while idle", async () => {
  vi.useFakeTimers();
  try {
    const { queue } = setup();
    queue.setRealtime(true);
    request.mockResolvedValueOnce({ revision: 1, scene: scene(["a"]) });
    queue.set(scene(["a"]));
    queue.remoteChanged();
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    queue.set(scene(["a"]));
    await vi.advanceTimersByTimeAsync(50);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    queue.set(scene(["a", "b"]));
    request.mockResolvedValueOnce({ revision: 2, scene: scene(["a", "b"]) });
    await vi.advanceTimersByTimeAsync(100);
    expect(request.mock.calls[1][2]).toMatchObject({
      scene: { elements: [expect.objectContaining({ id: "b" })], files: {} },
    });
  } finally {
    queues.forEach((queue) => queue.dispose());
    vi.useRealTimers();
  }
});

test("an event received during a request fetches the newer revision afterwards", async () => {
  const { queue, apply } = setup();
  let release!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  request.mockResolvedValueOnce({ revision: 2, scene: scene(["remote"]) });
  const pending = queue.flush();
  queue.remoteChanged();
  release({ revision: 1, scene: scene([]) });
  await pending;
  expect(request).toHaveBeenCalledTimes(2);
  expect(apply.mock.lastCall?.[0].elements[0].id).toBe("remote");
});
