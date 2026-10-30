import { useApi } from "../api.ts";
import { Panel } from "./ui.tsx";

interface AuditRow {
  id: number;
  login: string;
  role: string;
  action: string;
  detail: string;
  status: number;
  ts: string;
}

/** Who changed what in the admin UI, and what they were refused (the last 5000 are kept). */
export function AuditLog() {
  const { data } = useApi<AuditRow[]>("/api/audit?limit=50", (message) => message.type === "settings" || message.type === "agents" || message.type === "task");
  return (
    <Panel title="Audit log" hint="changes made here, newest first (GET /api/audit)">
      {!data?.length ? (
        <div className="meta">Nothing yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  <td className="nowrap meta">{new Date(row.ts).toLocaleString()}</td>
                  <td className="nowrap">
                    {row.login}
                    {row.role !== "admin" && <span className="meta"> ({row.role})</span>}
                  </td>
                  <td>
                    <code>{row.action}</code>
                    {row.status >= 400 && <span className="meta"> · {row.status === 403 ? "refused" : `failed (${row.status})`}</span>}
                  </td>
                  <td className="meta" style={{ overflowWrap: "anywhere" }}>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
