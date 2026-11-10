import { Code, VStack } from "@astryxdesign/core";
import { Schedules as ScheduleList } from "../components/Schedules.tsx";
import { Meta } from "../components/ui.tsx";

/** Every agent's schedules. */
export function Schedules() {
  return (
    <VStack gap={4}>
      <ScheduleList />
      <Meta block>
        A schedule starts its agent on the same thread with the same request each time it comes round. A run is skipped while the last one is still going, and a schedule pauses itself when several runs
        in a row fail. Agents can make their own when asked on GitHub (<Code size="inherit">can_schedule</Code> in agent.md), and agent.md can list fixed ones under <Code size="inherit">schedules:</Code>.
      </Meta>
    </VStack>
  );
}
