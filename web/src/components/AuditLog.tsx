import { Code, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text } from "@astryxdesign/core";
import { useApi } from "../api.ts";
import { DataTable, Meta, Panel } from "./ui.tsx";

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
    <Panel title="Audit log" hint="changes made here, newest first (GET /api/audit)" tight={Boolean(data?.length)}>
      {!data?.length ? (
        <Meta>Nothing yet.</Meta>
      ) : (
        <DataTable>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>When</TableHeaderCell>
              <TableHeaderCell>Who</TableHeaderCell>
              <TableHeaderCell>What</TableHeaderCell>
              <TableHeaderCell>Details</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Text type="supporting" textWrap="nowrap">
                    {new Date(row.ts).toLocaleString()}
                  </Text>
                </TableCell>
                <TableCell>
                  <Text textWrap="nowrap">
                    {row.login}
                    {row.role !== "admin" && <Meta> ({row.role})</Meta>}
                  </Text>
                </TableCell>
                <TableCell>
                  <Code size="inherit">{row.action}</Code>
                  {row.status >= 400 && <Meta> · {row.status === 403 ? "refused" : `failed (${row.status})`}</Meta>}
                </TableCell>
                <TableCell>
                  <Text type="supporting" wordBreak="break-all">
                    {row.detail}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
    </Panel>
  );
}
