import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { ConfigReference } from "./ConfigReference.tsx";

const OPTIONS_KEY = "ao.editor.options";

function readOptionsPreference(): boolean {
  try {
    return localStorage.getItem(OPTIONS_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/**
 * Edits one file in the profiles folder. The server validates it (frontmatter, JSON) before
 * saving, and commits it when the profiles folder is a git repository.
 */
export function FileEditor({
  path,
  initial,
  rows = 18,
  onSaved,
  onDeleted,
  deleteLabel,
}: {
  path: string;
  /** Content for a file that doesn't exist yet. */
  initial?: string;
  rows?: number;
  onSaved?: () => void;
  onDeleted?: () => void;
  deleteLabel?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [exists, setExists] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOptions, setShowOptions] = useState(readOptionsPreference);
  const toggleOptions = () => {
    setShowOptions((value) => {
      try {
        localStorage.setItem(OPTIONS_KEY, value ? "hidden" : "shown");
      } catch {
        // private window: the choice lasts for this page only
      }
      return !value;
    });
  };

  useEffect(() => {
    setContent(null);
    setError(null);
    setStatus(null);
    api
      .get<{ content: string }>(`/api/profiles/file?path=${encodeURIComponent(path)}`)
      .then((file) => {
        setContent(file.content);
        setSaved(file.content);
        setExists(true);
      })
      .catch(() => {
        setContent(initial ?? "");
        setSaved("");
        setExists(false);
      });
  }, [path, initial]);

  const save = async () => {
    if (content === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/profiles/file", { path, content });
      setSaved(content);
      setExists(true);
      setStatus("Saved");
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${path}${path.endsWith("agent.md") || path.endsWith("SKILL.md") ? " and its folder" : ""}?`)) return;
    try {
      await api.del(`/api/profiles/file?path=${encodeURIComponent(path)}`);
      onDeleted?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (content === null) return <div className="meta">Loading {path}…</div>;
  const dirty = content !== saved;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <code className="meta">{path}</code>
        {!exists && <span className="badge">new file</span>}
        {dirty && <span className="badge accent">unsaved</span>}
        <span className="grow" />
        {status && !dirty && <span className="meta">{status}</span>}
        <button className="small" onClick={toggleOptions} title="What this file can contain">
          {showOptions ? "Hide options" : "Options"}
        </button>
        {onDeleted && exists && (
          <button className="small danger" onClick={remove}>
            {deleteLabel ?? "Delete"}
          </button>
        )}
        <button className="small" disabled={!dirty} onClick={() => setContent(saved)}>
          Revert
        </button>
        <button className="small primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <div className={showOptions ? "editor-split" : undefined}>
        <textarea
          className="mono"
          rows={rows}
          spellCheck={false}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setStatus(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
        {showOptions && <ConfigReference path={path} />}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
