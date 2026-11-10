import { useState } from "react";
import { Button, HStack, TableBody, TableCell, TableRow, Text, TextInput } from "@astryxdesign/core";
import { ago, api, useApi, type BlockedUser } from "../api.ts";
import { DataTable, ErrorText, Meta, Panel } from "./ui.tsx";

/** Settings → Blocked users: accounts (another team's bots, say) whose requests agents turn down. */
export function BlockedUsers() {
  const { data, reload } = useApi<{ users: BlockedUser[] }>("/api/blocked-users", (message) => message.type === "settings");
  const [login, setLogin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const act = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await change();
      void reload();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const block = async () => {
    if (await act(() => api.post("/api/blocked-users", { login }))) setLogin("");
  };

  return (
    <Panel title="Blocked users" hint={data.users.length ? `${data.users.length} blocked` : "agents don't take requests from these accounts"}>
      <Meta block>
        When one of these accounts mentions or assigns an agent, the agent replies that it's blocked, once per thread and without @-mentioning it (it may be another agent), and doesn't start. What
        it says on a thread doesn't reach agents already working there either. Use it to stop agents talking to each other in circles.
      </Meta>
      {data.users.length > 0 && (
        <DataTable>
          <TableBody>
            {data.users.map((user) => (
              <TableRow key={user.login}>
                <TableCell>
                  <Text type="code" textWrap="nowrap">{user.login}</Text>
                </TableCell>
                <TableCell>
                  <Meta>
                    by {user.addedBy} · {ago(user.addedAt)}
                  </Meta>
                </TableCell>
                <TableCell>
                  <HStack hAlign="end">
                    <Button label="Unblock" size="sm" isDisabled={busy} onClick={() => void act(() => api.del(`/api/blocked-users/${encodeURIComponent(user.login)}`))} />
                  </HStack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      )}
      <HStack gap={2} vAlign="end" wrap="wrap">
        <TextInput
          label="GitHub account"
          isLabelHidden
          placeholder="login, e.g. other-team-bot"
          width={240}
          value={login}
          onChange={(value) => setLogin(value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && login) void block();
          }}
        />
        <Button label={busy ? "Saving…" : "Block"} isDisabled={!login || busy} onClick={() => void block()} />
      </HStack>
      {error && <ErrorText>{error}</ErrorText>}
    </Panel>
  );
}
