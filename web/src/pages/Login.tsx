import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useRoute } from "../router.ts";

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
    <div className="login">
      <section className="panel">
        <div className="panel-head">
          <span className="brand-mark" aria-hidden>
            ◉
          </span>
          <h2>Agent Orchestrator</h2>
        </div>
        <div className="panel-body stack" style={{ gap: 14 }}>
          {githubLogin && (
            <>
              {signInProblem ? (
                <div className="banner error">
                  <span>
                    {signInProblem} Until then, sign in with the admin token below.
                  </span>
                </div>
              ) : elsewhere ? (
                <div className="banner">
                  <span>
                    You opened this page at {window.location.origin}, but PUBLIC_URL is {elsewhere}, so GitHub will send you back there. Open {elsewhere}, or set PUBLIC_URL to the
                    address you use (and update the GitHub App's Callback URL to match).
                  </span>
                </div>
              ) : null}
              <a className="button primary" href="/api/auth/github" style={{ width: "100%" }}>
                Sign in with GitHub
              </a>
              {callbackUrl && (
                <span className="help">
                  If GitHub says the redirect_uri isn't associated with this application, set the App's Callback URL to <code>{callbackUrl}</code>.
                </span>
              )}
              <div className="divider">or</div>
            </>
          )}
          <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
            <div className="field">
              <label htmlFor="admin-token">Admin token</label>
              <input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} />
              <span className="help">From ADMIN_TOKEN, or the admin-token file in the data directory (the first start also prints it in the logs).</span>
            </div>
            <button type="submit" disabled={!token.trim() || busy}>
              {busy ? "Signing in…" : "Sign in with token"}
            </button>
          </form>
          {error && <p className="error-text">{error}</p>}
        </div>
      </section>
    </div>
  );
}
