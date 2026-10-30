import { EventEmitter } from "node:events";
import type { Delivery, Task, TaskEvent } from "./types.ts";

export type BusMessage =
  | { type: "task"; task: Task }
  | { type: "event"; event: TaskEvent }
  | { type: "delivery"; delivery: Delivery }
  | { type: "agents" }
  | { type: "settings" }
  | { type: "sessions" }
  | { type: "limits" }
  | { type: "boards" }
  | { type: "incidents" }
  | { type: "schedules" };

/** In-process fan-out of changes to the admin UI's live stream. */
class Bus extends EventEmitter {
  publish(message: BusMessage): void {
    this.emit("message", message);
  }
  subscribe(listener: (message: BusMessage) => void): () => void {
    this.on("message", listener);
    return () => this.off("message", listener);
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
