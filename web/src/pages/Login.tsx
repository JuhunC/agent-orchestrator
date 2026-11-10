import { useState, type FormEvent } from "react";
import { Button, Card, Code, Divider, Heading, HStack, Icon, NavIcon, TextInput, VStack } from "@astryxdesign/core";
import { Bot } from "lucide-react";
import { api } from "../api.ts";
import { useRoute } from "../router.ts";
import { ErrorText, Meta, Notice } from "../components/ui.tsx";

export function Login({
  githubLogin,
  callbackUrl,
  signInProblem,
  onSignedIn,
}: {
  githubLogin: boolean;
  callbackUrl: string | null;
  signInProblem: string | null;
  onSignedIn: () => void;
}) {
  // PUBLIC_URL decides where GitHub sends people back; opening the app at another address can't work.
  const publicOrigin = callbackUrl ? new URL(callbackUrl).origin : null;
  const elsewhere = publicOrigin && publicOrigin !== window.location.origin ? publicOrigin : null;
  const route = useRoute();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(route.query.get("error"));
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/token", { token: token.trim() });
      window.location.hash = "/";
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ao-login">
      <Card maxWidth={440} width="100%" elevation="low">
        <VStack gap={4}>
          <HStack gap={2} vAlign="center">
            <NavIcon icon={<Icon icon={Bot} size="sm" />} />
            <Heading level={1}>Agent Orchestrator</Heading>
          </HStack>
          {githubLogin && (
            <>
              {signInProblem ? (
                <Notice tone="error" title={signInProblem}>
                  Until then, sign in with the admin token below.
                </Notice>
              ) : elsewhere ? (
                <Notice title={`You opened this page at ${window.location.origin}, but PUBLIC_URL is ${elsewhere}, so GitHub will send you back there.`}>
                  Open {elsewhere}, or set PUBLIC_URL to the address you use (and update the GitHub App's Callback URL to match).
                </Notice>
              ) : null}
              <Button label="Sign in with GitHub" variant="primary" href="/api/auth/github" width="100%" />
              {callbackUrl && (
                <Meta block>
                  If GitHub says the redirect_uri isn't associated with this application, set the App's Callback URL to <Code size="inherit">{callbackUrl}</Code>.
                </Meta>
              )}
              <Divider label="or" />
            </>
          )}
          <form onSubmit={submit}>
            <VStack gap={3}>
              <TextInput
                label="Admin token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={setToken}
                description="From ADMIN_TOKEN, or the admin-token file in the data directory (the first start also prints it in the logs)."
              />
              <Button label={busy ? "Signing in…" : "Sign in with token"} type="submit" width="100%" isDisabled={!token.trim() || busy} />
            </VStack>
          </form>
          {error && <ErrorText>{error}</ErrorText>}
        </VStack>
      </Card>
    </div>
  );
}
