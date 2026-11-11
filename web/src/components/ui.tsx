import { useId, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  Code,
  Dialog as AstryxDialog,
  Grid,
  DialogHeader,
  Heading,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Link,
  MetadataList,
  MetadataListItem,
  Selector,
  StackItem,
  Switch as AstryxSwitch,
  Table,
  Text,
  TextInput,
  Token,
  VStack,
  type TextInputProps,
} from "@astryxdesign/core";
import { api, KIND_LABEL, type Task, type TaskOutcome, type TaskPriority, type TaskStatus } from "../api.ts";
import { href } from "../router.ts";

type BadgeVariant = "neutral" | "info" | "success" | "warning" | "error" | "blue" | "purple";

const STATUS: Record<TaskStatus, { label: string; variant: BadgeVariant }> = {
  queued: { label: "Queued", variant: "warning" },
  running: { label: "Running", variant: "info" },
  succeeded: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "neutral" },
};

const PAUSED = { label: "Paused", variant: "purple" } as const;

/** Tones the old pills used, mapped to Astryx badge variants. */
const TONE: Record<string, BadgeVariant> = {
  queued: "warning",
  running: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "neutral",
  off: "neutral",
  triggered: "success",
  forwarded: "info",
  ignored: "neutral",
  rejected: "warning",
  error: "error",
  accent: "purple",
};

/** A task that ended without an error, but whose agent said it didn't do all of it. */
const REPORTED: Record<string, { label: string; variant: BadgeVariant }> = {
  partial: { label: "Partly done", variant: "warning" },
  blocked: { label: "Blocked", variant: "warning" },
  gave_up: { label: "Gave up", variant: "error" },
};

/** `paused`: a queued task its agent paused until other work is done (api.ts `isPaused`). */
export function StatusPill({ status, outcome, paused }: { status: TaskStatus; outcome?: TaskOutcome | null; paused?: boolean }) {
  const shown = (status === "succeeded" && outcome && REPORTED[outcome]) || (status === "queued" && paused ? PAUSED : STATUS[status]);
  return <Badge variant={shown.variant} label={shown.label} />;
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <Badge variant={TONE[tone] ?? "neutral"} label={children} />;
}

/** A small label for metadata: a kind, a column, a skill. */
export function Tag({ children, accent, href: link }: { children: string; accent?: boolean; href?: string }) {
  return <Token size="sm" color={accent ? "purple" : "default"} label={children} href={link} />;
}

/** A task's place in the queue, shown only when it isn't the usual one. */
export function PriorityTag({ priority }: { priority: TaskPriority }) {
  if (priority === "normal") return null;
  return <Token size="sm" color={priority === "high" ? "orange" : "gray"} label={priority === "high" ? "High priority" : "Low priority"} />;
}

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

/** Moves a queued task up or down the queue: high goes before the rest, low after it. */
export function PrioritySelect({ task, width = 104 }: { task: Task; width?: number }) {
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Selector
        label={`Priority of task #${task.id}`}
        isLabelHidden
        size="sm"
        width={width}
        options={PRIORITIES}
        value={task.priority}
        onChange={(value) => value && value !== task.priority && void api.post(`/api/tasks/${task.id}/priority`, { priority: value })}
      />
    </span>
  );
}

export function Chips({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <Meta>{empty}</Meta>;
  return (
    <HStack gap={1} wrap="wrap">
      {items.map((item) => (
        <Tag key={item}>{item}</Tag>
      ))}
    </HStack>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <AstryxSwitch label={label} isLabelHidden value={checked} isDisabled={disabled} onChange={(value) => onChange(value)} size="sm" />;
}

/** Secondary text: hints, timestamps, explanations. */
export function Meta({ children, block }: { children: ReactNode; block?: boolean }) {
  return (
    <Text type="supporting" display={block ? "block" : "inline"}>
      {children}
    </Text>
  );
}

/** Several messages, one per line (inside a Notice, say). */
export function Lines({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <Text key={item} display="block">
          {item}
        </Text>
      ))}
    </>
  );
}

/** Text in the error color, for a field's or an action's problem. */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text display="block" className="ao-error-text">
      {children}
    </Text>
  );
}

/** A headline number with a label and a line of context. */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Text size="2xl" weight="semibold" hasTabularNumbers display="block">
          {value}
        </Text>
        {sub && <Meta block>{sub}</Meta>}
      </VStack>
    </Card>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <Grid columns={{ minWidth: 140 }} gap={3}>
      {children}
    </Grid>
  );
}

/** Two (or more) panels side by side on wide screens, stacked on narrow ones. */
export function Columns({ children, min = 440 }: { children: ReactNode; min?: number }) {
  return (
    <Grid columns={{ minWidth: min, max: 2 }} gap={4} align="start">
      {children}
    </Grid>
  );
}

/** A link inside the app (hash route) or to GitHub (opens a new tab). */
export function A({ to, children, external }: { to: string; children: ReactNode; external?: boolean }) {
  if (external) {
    return (
      <Link href={to} isExternalLink type="inherit" onClick={(event) => event.stopPropagation()}>
        {children}
      </Link>
    );
  }
  return (
    <Link href={href(to)} type="inherit" onClick={(event) => event.stopPropagation()}>
      {children}
    </Link>
  );
}

/** A titled block of the page: a card with a header row and a body. */
export function Panel({ title, actions, hint, children, tight }: { title?: ReactNode; actions?: ReactNode; hint?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <Card padding={0}>
      {title !== undefined && (
        <HStack gap={3} vAlign="center" wrap="wrap" paddingInline={4} paddingBlockStart={3} paddingBlockEnd={tight ? 3 : 0}>
          <StackItem size="fill">
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={2}>{title}</Heading>
              {hint && <Meta>{hint}</Meta>}
            </HStack>
          </StackItem>
          {actions}
        </HStack>
      )}
      <VStack gap={3} padding={tight ? 0 : 4}>
        {children}
      </VStack>
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <VStack padding={6} hAlign="center">
      <Text color="secondary" justify="center" display="block">
        {children}
      </Text>
    </VStack>
  );
}

/** A page-level message: an error, a warning, or information. */
export function Notice({ tone = "warning", title, children, action }: { tone?: "info" | "warning" | "error" | "success"; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <Banner status={tone} title={title} description={children} endContent={action} />;
}

/** Label and value pairs. */
export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <MetadataList label={{ position: "start", width: 150 }}>
      {items.map(([label, value]) => (
        <MetadataListItem key={label} label={label}>
          {value}
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

export function Dialog({ title, onClose, children, footer, width = 560 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <AstryxDialog isOpen width={width} maxHeight="90dvh" purpose="form" onOpenChange={(open) => !open && onClose()}>
      <Layout
        height="auto"
        header={<DialogHeader title={title} onOpenChange={(open) => !open && onClose()} />}
        content={
          <LayoutContent padding={4}>
            <VStack gap={4}>{children}</VStack>
          </LayoutContent>
        }
        footer={
          footer ? (
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="end" wrap="wrap">
                {footer}
              </HStack>
            </LayoutFooter>
          ) : undefined
        }
      />
    </AstryxDialog>
  );
}

/** A text field with suggestions from a list (owner/repo, model names); any text is allowed. */
export function SuggestInput({ suggestions, ...props }: TextInputProps & { suggestions: string[] }) {
  const id = useId();
  return (
    <>
      <TextInput {...props} {...({ list: id } as object)} />
      <datalist id={id}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

/** A table that sizes columns to their content; rows can be clicked when `hover` is set. */
export function DataTable({ children, hover }: { children: ReactNode; hover?: boolean }) {
  return (
    <Table density="compact" hasHover={hover} className="ao-table">
      {children}
    </Table>
  );
}

/** Buttons that act on a row, kept on one line. */
export function Actions({ children }: { children: ReactNode }) {
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {children}
    </HStack>
  );
}

/** "acme/widgets#12 · Fix the thing" with links to the task and GitHub. */
export function ThreadCell({ task, linkTask = true, priority = true }: { task: Task; linkTask?: boolean; priority?: boolean }) {
  const label = `${task.owner}/${task.repo}#${task.threadNumber}`;
  return (
    <VStack gap={0.5} maxWidth={420}>
      <Text weight="medium" maxLines={1}>
        {task.threadTitle || <Meta>(title loads when the task starts)</Meta>}
      </Text>
      <HStack gap={1} vAlign="center" wrap="wrap">
        <Tag>{KIND_LABEL[task.threadKind]}</Tag>
        {task.boardColumn && <Tag accent>{task.boardColumn}</Tag>}
        {priority && <PriorityTag priority={task.priority} />}
        <Meta>
          {linkTask ? <A to={`/tasks/${task.id}`}>{label}</A> : label}
          {task.threadUrl && (
            <>
              {" · "}
              <A to={task.threadUrl} external>
                GitHub
              </A>
            </>
          )}
        </Meta>
      </HStack>
    </VStack>
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
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <Code size="inherit" key={index}>{part.slice(1, -1)}</Code> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

/** A button that only navigates: rendered as a link. */
export function LinkButton({ to, label, external, variant = "secondary", size = "md" }: { to: string; label: string; external?: boolean; variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" }) {
  return external ? (
    <Button label={label} href={to} target="_blank" rel="noreferrer" variant={variant} size={size} />
  ) : (
    <Button label={label} href={href(to)} variant={variant} size={size} />
  );
}
