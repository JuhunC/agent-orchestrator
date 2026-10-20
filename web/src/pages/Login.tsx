import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useRoute } from "../router.ts";

export function Login({ githubLogin, onSignedIn }: { githubLogin: boolean; onSignedIn: () => void }) {
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
              <a className="button primary" href="/api/auth/github" style={{ width: "100%" }}>
                Sign in with GitHub
              </a>
              <div className="divider">or</div>
            </>
          )}
          <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
            <div className="field">
              <label htmlFor="admin-token">Admin token</label>
              <input id="admin-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} />
              <span className="help">From ADMIN_TOKEN, or the admin-token file in the data directory.</span>
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
