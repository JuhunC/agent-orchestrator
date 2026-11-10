import { useState } from "react";
import { HStack, Selector, StackItem, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, VStack } from "@astryxdesign/core";
import { useApi, useNow, useStream, ago, type Delivery } from "../api.ts";
import { DataTable, Empty, Meta, Panel, Pill } from "../components/ui.tsx";

const DECISIONS = [
  { value: "", label: "All decisions" },
  { value: "triggered", label: "Triggered" },
  { value: "forwarded", label: "Forwarded to a running agent" },
  { value: "ignored", label: "Ignored" },
  { value: "rejected", label: "Rejected" },
  { value: "error", label: "Error" },
];

export function Deliveries() {
  const { data, setData } = useApi<Delivery[]>("/api/deliveries");
  const [filter, setFilter] = useState("");
  const now = useNow(10_000);
  useStream((message) => {
    if (message.type === "delivery") setData((current) => [message.delivery, ...(current ?? [])].slice(0, 300));
  });
  const rows = (data ?? []).filter((delivery) => !filter || delivery.decision === filter);

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text color="secondary">Every webhook GitHub sent, and what the orchestrator decided to do with it.</Text>
        </StackItem>
        <Selector label="Decision" isLabelHidden width={260} options={DECISIONS} value={filter} placeholder="All decisions" onChange={(value) => setFilter(value ?? "")} />
      </HStack>
      <Panel tight>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>No webhooks yet. Once the GitHub App is installed, events show up here as they arrive.</Empty>
        ) : (
          <DataTable>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Event</TableHeaderCell>
                <TableHeaderCell>Repository</TableHeaderCell>
                <TableHeaderCell>Sender</TableHeaderCell>
                <TableHeaderCell>Decision</TableHeaderCell>
                <TableHeaderCell>Detail</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell>
                    <span title={delivery.ts}>
                      <Text type="supporting" textWrap="nowrap">
                        {ago(delivery.ts, now)}
                      </Text>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Text type="code">
                      {delivery.event}
                      {delivery.action && `.${delivery.action}`}
                    </Text>
                  </TableCell>
                  <TableCell>{delivery.repo || "—"}</TableCell>
                  <TableCell>{delivery.sender || "—"}</TableCell>
                  <TableCell>
                    <Pill tone={delivery.decision}>{delivery.decision}</Pill>
                  </TableCell>
                  <TableCell>
                    <Meta>{delivery.detail}</Meta>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        )}
      </Panel>
    </VStack>
  );
}
