import { useState } from "react";
import { Badge, Button, Code, CodeBlock, Divider, HStack, StackItem, Text, TextInput, VStack } from "@astryxdesign/core";
import { useApi, type ConfigFileDoc, type ConfigOption, type ConfigReference as Reference } from "../api.ts";
import { Meta } from "./ui.tsx";

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
    <Button
      label={copied ? "Copied" : "Copy"}
      size="sm"
      variant="ghost"
      tooltip={text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    />
  );
}

function Values({ label, values }: { label: string; values: string[] }) {
  return (
    <HStack gap={1} wrap="wrap" vAlign="center">
      <Meta>{label}</Meta>
      {values.length ? values.map((value) => <Code size="inherit" key={value}>{value}</Code>) : <Meta>none yet</Meta>}
    </HStack>
  );
}

function Option({ option, available }: { option: ConfigOption; available: string[] | null }) {
  const leaf = option.key.split(".").at(-1)!;
  return (
    <VStack gap={1}>
      <HStack gap={1.5} vAlign="center" wrap="wrap">
        <Code size="inherit">{leaf}</Code>
        {option.required && <Badge variant="purple" label="required" />}
        <Meta>{option.type}</Meta>
        <StackItem size="fill">
          <span />
        </StackItem>
        {option.example && <CopyButton text={option.example} />}
      </HStack>
      <Text type="supporting" color="primary" display="block">
        {option.description}
      </Text>
      {option.values && <Values label="One of:" values={option.values} />}
      {available && <Values label="Available now:" values={available} />}
      {option.default !== undefined && <Meta block>Default: {option.default}</Meta>}
      {option.example && <CodeBlock code={option.example} size="sm" width="100%" hasCopyButton={false} isWrapped />}
    </VStack>
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
  if (!data)
    return (
      <div className="ao-reference">
        <Meta>Loading options…</Meta>
      </div>
    );
  if (!doc) return null;
  const needle = filter.trim().toLowerCase();
  const options = doc.options.filter((option) => !needle || `${option.key} ${option.description} ${(option.values ?? []).join(" ")}`.toLowerCase().includes(needle));
  const sections = [...new Set(options.map((option) => section(option.key)))];
  return (
    <div className="ao-reference">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <Text weight="semibold">{doc.title}</Text>
          </StackItem>
          <Badge variant="neutral" label={doc.format === "markdown" ? "Markdown + YAML frontmatter" : doc.format.toUpperCase()} />
        </HStack>
        <Text type="supporting" color="primary" display="block">
          {doc.summary}
        </Text>
        {doc.body && (
          <Text type="supporting" color="primary" display="block">
            Below the frontmatter: {doc.body}
          </Text>
        )}
        <TextInput label="Filter options" isLabelHidden size="sm" placeholder={`Filter ${doc.options.length} options`} value={filter} onChange={setFilter} hasClear />
        {sections.map((name) => (
          <VStack key={name || "top"} gap={3}>
            <Divider label={name ? <Code size="inherit">{name}</Code> : "Top level"} />
            {options
              .filter((option) => section(option.key) === name)
              .map((option) => (
                <Option key={option.key} option={option} available={option.source ? data.values[option.source] : null} />
              ))}
          </VStack>
        ))}
        {options.length === 0 && <Meta>No option matches "{filter}".</Meta>}
      </VStack>
    </div>
  );
}
