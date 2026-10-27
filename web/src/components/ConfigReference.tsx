import { useState } from "react";
import { useApi, type ConfigFileDoc, type ConfigOption, type ConfigReference as Reference } from "../api.ts";

/** The reference entry for a profile file, if there is one (e.g. not for a skill's extra files). */
export function docFor(reference: Reference | null, path: string): ConfigFileDoc | null {
  return reference?.files.find((file) => new RegExp(file.pattern).test(path)) ?? null;
}

/** The section an option belongs to: "github" for github.push, "columns.<name>" for columns.<name>.role. */
function section(key: string): string {
  const parts = key.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="small"
      title={text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Option({ option, available }: { option: ConfigOption; available: string[] | null }) {
  const leaf = option.key.split(".").at(-1)!;
  return (
    <div className="reference-option">
      <div className="row" style={{ gap: 6 }}>
        <code>{leaf}</code>
        {option.required && <span className="badge accent">required</span>}
        <span className="meta">{option.type}</span>
        <span className="grow" />
        {option.example && <CopyButton text={option.example} />}
      </div>
      <div className="reference-text">{option.description}</div>
      {option.values && (
        <div className="reference-values">
          <span className="meta">One of:</span>
          {option.values.map((value) => (
            <code key={value}>{value}</code>
          ))}
        </div>
      )}
      {available && (
        <div className="reference-values">
          <span className="meta">Available now:</span>
          {available.length ? available.map((value) => <code key={value}>{value}</code>) : <span className="meta">none yet</span>}
        </div>
      )}
      {option.default !== undefined && <div className="meta">Default: {option.default}</div>}
      {option.example && <pre className="reference-example">{option.example}</pre>}
    </div>
  );
}

/**
 * The options a profile file can set (from the server's reference): type, allowed values, the
 * skills/agents/roles that exist now, the default, and an example to copy.
 */
export function ConfigReference({ path }: { path: string }) {
  const { data } = useApi<Reference>("/api/profiles/reference", (message) => message.type === "agents");
  const [filter, setFilter] = useState("");
  const doc = docFor(data, path);
  if (!data) return <div className="reference meta">Loading options…</div>;
  if (!doc) return null;
  const needle = filter.trim().toLowerCase();
  const options = doc.options.filter((option) => !needle || `${option.key} ${option.description} ${(option.values ?? []).join(" ")}`.toLowerCase().includes(needle));
  const sections = [...new Set(options.map((option) => section(option.key)))];
  return (
    <div className="reference">
      <div className="row" style={{ gap: 6 }}>
        <b className="grow">{doc.title}</b>
        <span className="badge">{doc.format === "markdown" ? "Markdown + YAML frontmatter" : doc.format.toUpperCase()}</span>
      </div>
      <p className="reference-text">{doc.summary}</p>
      {doc.body && <p className="reference-text">Below the frontmatter: {doc.body}</p>}
      <input placeholder={`Filter ${doc.options.length} options`} value={filter} onChange={(event) => setFilter(event.target.value)} />
      {sections.map((name) => (
        <div key={name || "top"} className="reference-section">
          <div className="reference-heading">{name ? <code>{name}</code> : "Top level"}</div>
          {options
            .filter((option) => section(option.key) === name)
            .map((option) => (
              <Option key={option.key} option={option} available={option.source ? data.values[option.source] : null} />
            ))}
        </div>
      ))}
      {options.length === 0 && <p className="meta">No option matches "{filter}".</p>}
    </div>
  );
}
