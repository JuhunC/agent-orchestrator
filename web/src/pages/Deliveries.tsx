import { useState } from "react";
import { useApi, useNow, useStream, ago, type Delivery } from "../api.ts";
import { Empty, Panel, Pill } from "../components/ui.tsx";

export function Deliveries() {
  const { data, setData } = useApi<Delivery[]>("/api/deliveries");
  const [filter, setFilter] = useState("");
  const now = useNow(10_000);
  useStream((message) => {
    if (message.type === "delivery") setData((current) => [message.delivery, ...(current ?? [])].slice(0, 300));
  });
  const rows = (data ?? []).filter((delivery) => !filter || delivery.decision === filter);

  return (
    <div className="stack">
      <div className="page-head">
        <span className="sub">Every webhook GitHub sent, and what the orchestrator decided to do with it.</span>
        <span className="spacer" />
        <select aria-label="Decision" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ width: "auto" }}>
          <option value="">All decisions</option>
          <option value="triggered">Triggered</option>
          <option value="ignored">Ignored</option>
          <option value="rejected">Rejected</option>
          <option value="error">Error</option>
        </select>
      </div>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>No webhooks yet. Once the GitHub App is installed, events show up here as they arrive.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Repository</th>
                  <th>Sender</th>
                  <th>Decision</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((delivery) => (
                  <tr key={delivery.id}>
                    <td className="num meta" title={delivery.ts}>
                      {ago(delivery.ts, now)}
                    </td>
                    <td className="mono">
                      {delivery.event}
                      {delivery.action && `.${delivery.action}`}
                    </td>
                    <td>{delivery.repo || "—"}</td>
                    <td>{delivery.sender || "—"}</td>
                    <td>
                      <Pill tone={delivery.decision}>{delivery.decision}</Pill>
                    </td>
                    <td className="meta" style={{ maxWidth: 420 }}>
                      {delivery.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
