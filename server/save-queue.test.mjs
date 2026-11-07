import test from "node:test";
import assert from "node:assert/strict";
import { SaveQueue } from "../excalidraw-app/workspace/SaveQueue.mjs";

test("serializes saves and writes changes made during an in-flight request", async () => {
  let release;
  const calls = [];
  const queue = new SaveQueue(
    "initial",
    0,
    async (scene, revision) => {
      calls.push([scene, revision]);
      if (calls.length === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return revision + 1;
    },
    () => {},
  );
  queue.set("first");
  const pending = queue.flush();
  queue.set("latest");
  release();
  await pending;
  assert.deepEqual(calls, [
    ["first", 0],
    ["latest", 1],
  ]);
  assert.equal(queue.dirty, false);
  queue.dispose();
});

test("failed writes preserve dirty state and revision for explicit retry", async () => {
  let fail = true;
  const queue = new SaveQueue(
    "saved",
    4,
    async (_, revision) => {
      if (fail) {
        throw new Error("offline");
      }
      return revision + 1;
    },
    () => {},
  );
  queue.set("unsaved");
  await assert.rejects(queue.flush());
  assert.equal(queue.dirty, true);
  assert.equal(queue.revision, 4);
  fail = false;
  await queue.flush();
  assert.equal(queue.dirty, false);
  assert.equal(queue.revision, 5);
  queue.dispose();
});

test("reverting an edit during a save still persists the reverted scene", async () => {
  let release;
  const saved = [];
  const queue = new SaveQueue(
    "initial",
    0,
    async (scene, revision) => {
      saved.push(scene);
      if (saved.length === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return revision + 1;
    },
    () => {},
  );
  queue.set("edit");
  const pending = queue.flush();
  queue.set("initial");
  release();
  await pending;
  assert.deepEqual(saved, ["edit", "initial"]);
  queue.dispose();
});
