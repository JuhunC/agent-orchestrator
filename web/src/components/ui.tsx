import { useEffect, type ReactNode } from "react";
import { KIND_LABEL, type Task, type TaskStatus } from "../api.ts";
import { href } from "../router.ts";

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span />
    </label>
  );
}

export function Panel({ title, actions, hint, children, tight }: { title?: ReactNode; actions?: ReactNode; hint?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <section className="panel">
      {title !== undefined && (
        <div className="panel-head">
          <h2>{title}</h2>
          {hint && <span className="hint">{hint}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      <div className={`panel-body${tight ? " tight" : ""}`}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** "acme/widgets#12 · Fix the thing" with links to the task and GitHub. */
export function ThreadCell({ task, linkTask = true }: { task: Task; linkTask?: boolean }) {
  const label = `${task.owner}/${task.repo}#${task.threadNumber}`;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="title ellipsis">{task.threadTitle || <span className="meta">(title loads when the task starts)</span>}</div>
      <div className="meta">
        <span className="badge">{KIND_LABEL[task.threadKind]}</span>{" "}
        {task.boardColumn && (
          <>
            <span className="badge accent">{task.boardColumn}</span>{" "}
          </>
        )}
        {linkTask ? (
          <a href={href(`/tasks/${task.id}`)} onClick={(event) => event.stopPropagation()}>
            {label}
          </a>
        ) : (
          label
        )}
        {task.threadUrl && (
          <>
            {" · "}
            <a href={task.threadUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
              GitHub ↗
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export function who(login: string): string {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login) ? `@${login}` : login;
}

/** Renders `backtick` segments of agent step text as inline code. */
export function StepText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code> : <span key={index}>{part}</span>,
      )}
    </>
  );
}
