import { Schedules as ScheduleList } from "../components/Schedules.tsx";

/** Every agent's schedules. */
export function Schedules() {
  return (
    <div className="stack">
      <ScheduleList />
      <p className="meta" style={{ margin: 0 }}>
        A schedule starts its agent on the same thread with the same request each time it comes round. A run is skipped while the last one is still going, and a schedule pauses itself
        when several runs in a row fail. Agents can make their own when asked on GitHub (<code>can_schedule</code> in agent.md), and agent.md can list fixed ones under <code>schedules:</code>.
      </p>
    </div>
  );
}
