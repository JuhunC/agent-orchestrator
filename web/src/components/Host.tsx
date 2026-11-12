import { Button, Code } from "@astryxdesign/core";
import type { Settings } from "../api.ts";
import { KV, Meta, Notice, Panel, Pill } from "./ui.tsx";

export const megabytes = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** Settings → Host: where agents run, how much room it has, and when it holds new tasks back. */
export function HostPanel({ host, onRefresh }: { host: Settings["host"]; onRefresh: () => void }) {
  const { limits } = host;
  const checked = limits.minFreeMemoryMb > 0 || limits.maxLoad > 0;
  return (
    <Panel title="Host" hint="where agents run" actions={<Button label="Refresh" size="sm" onClick={onRefresh} />}>
      {host.holding && (
        <Notice title="Queued tasks are waiting for the host.">
          {host.holding}. Running agents carry on, and the next task starts when one finishes or the host has room again.
        </Notice>
      )}
      <KV
        items={[
          ["Agents run on", `${host.executor}, ${host.cpus} CPU${host.cpus === 1 ? "" : "s"}`],
          [
            "Memory",
            <>
              {megabytes(host.freeMb)} free of {megabytes(host.totalMb)}
              <Meta block>
                {limits.minFreeMemoryMb ? (
                  `another agent starts with ${megabytes(limits.minFreeMemoryMb)} or more free`
                ) : (
                  <>
                    not checked (<Code size="inherit">HOST_MIN_FREE_MEMORY_MB=0</Code>)
                  </>
                )}
              </Meta>
            </>,
          ],
          [
            "Load",
            <>
              {host.loadPerCpu === null ? "not reported by this system" : `${host.loadPerCpu.toFixed(2)} per CPU, over the last minute`}
              <Meta block>
                {limits.maxLoad ? (
                  `another agent starts at ${limits.maxLoad} or less`
                ) : (
                  <>
                    not checked (<Code size="inherit">HOST_MAX_LOAD=0</Code>)
                  </>
                )}
              </Meta>
            </>,
          ],
          ["Now", host.holding ? <Pill tone="queued">Holding new tasks</Pill> : host.pressure ? <Pill tone="queued">Short of room</Pill> : checked ? <Pill tone="succeeded">Room for more agents</Pill> : <Pill tone="off">Not checked</Pill>],
        ]}
      />
      <Meta block>
        Every agent is a process on this host. While the host is short of memory or busy, tasks start one after another instead of side by side: one task always runs, so the queue never stops. Limits are set with environment
        variables.
      </Meta>
    </Panel>
  );
}
