import { useState } from "react";
import { Button, Code, HStack } from "@astryxdesign/core";
import { api, useApi } from "../api.ts";
import { Meta, Notice, Panel } from "./ui.tsx";

interface BackupsResponse {
  dir: string;
  keep: number;
  database: { kb: number; freeKb: number };
  detailRetentionDays: number;
  backups: { name: string; at: string; kb: number; files: string[] }[];
}

/** Snapshots of the database and key files: taken daily, and on demand. */
export function Backups() {
  const { data, reload } = useApi<BackupsResponse>("/api/backups", (message) => message.type === "settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  return (
    <Panel title="Backups" hint={data.keep ? `daily, the last ${data.keep} kept` : "off (BACKUP_KEEP=0)"}>
      {data.backups.length ? (
        <Meta block>
          Latest: {new Date(data.backups[0]!.at).toLocaleString()} ({data.backups[0]!.kb} KB: {data.backups[0]!.files.join(", ")}). {data.backups.length} kept in <Code size="inherit">{data.dir}</Code>.
        </Meta>
      ) : (
        <Meta block>
          No backups yet. They go to <Code size="inherit">{data.dir}</Code>.
        </Meta>
      )}
      <Meta block>
        Database: {(data.database.kb / 1024).toFixed(1)} MB.{" "}
        {data.detailRetentionDays ? `Prompts and step logs of tasks older than ${data.detailRetentionDays} days are dropped; the tasks stay.` : "Tasks' prompts and step logs are kept forever (TASK_DETAIL_RETENTION_DAYS=0)."}
      </Meta>
      {error && <Notice tone="error" title={error} />}
      <HStack>
        <Button
          label={busy ? "Backing up…" : "Back up now"}
          isDisabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.post("/api/backups");
              void reload();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
              setBusy(false);
            }
          }}
        />
      </HStack>
      <Meta block>
        Each holds the database (tasks, history, settings, agents' encrypted GitHub tokens) and the key files (the GitHub App's credentials, <Code size="inherit">data-key</Code>, the session secret, the admin token), so keep
        copies somewhere safe, off this server. Workspaces are clones and aren't included; the profiles folder is its own git repository. See the README for restoring.
      </Meta>
    </Panel>
  );
}
