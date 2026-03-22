export type IssueCause = "config" | "task-difficulty" | "llm-limitation";
export type IssueCategory = "coverage" | "accuracy" | "structure" | "citations" | "other";

export interface EvaluationIssue {
  category: IssueCategory;
  description: string;
  evidence: string;
  cause: IssueCause;
}

export interface EvaluationReport {
  qualityScore: number;
  issues: EvaluationIssue[];
  summary: string;
}

const issueCategories: IssueCategory[] = ["coverage", "accuracy", "structure", "citations", "other"];
const issueCauses: IssueCause[] = ["config", "task-difficulty", "llm-limitation"];

function normalizeCategory(value: string | undefined): IssueCategory {
  const lowered = (value ?? "").trim().toLowerCase();
  return issueCategories.find((entry) => entry === lowered) ?? "other";
}

function normalizeCause(value: string | undefined): IssueCause {
  const lowered = (value ?? "").trim().toLowerCase();
  return issueCauses.find((entry) => entry === lowered) ?? "task-difficulty";
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractSection(text: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const match = text.match(regex);
  return (match?.[1] ?? "").trim();
}

function extractInlineField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`, "i");
  return (text.match(regex)?.[1] ?? "").trim();
}

function parseIssues(text: string): EvaluationIssue[] {
  const issueSection = extractSection(text, "Issues");
  const source = issueSection.length > 0 ? issueSection : text;
  const matches = [...source.matchAll(/(?:^|\n)(?:[-*]|\d+\.)?\s*Category\s*:\s*([^\n]+)([\s\S]*?)(?=(?:\n(?:[-*]|\d+\.)?\s*Category\s*:)|\n##\s+|$)/gi)];

  return matches.map((match) => {
    const category = normalizeCategory(match[1]);
    const body = match[2] ?? "";
    const description = extractInlineField(body, "Description") || "No description provided";
    const evidence = extractInlineField(body, "Evidence") || "No evidence provided";
    const cause = normalizeCause(extractInlineField(body, "Cause"));
    return { category, description, evidence, cause };
  });
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const issues = report.issues
    .map((issue, index) => [
      `${index + 1}. Category: ${issue.category}`,
      `   Description: ${issue.description}`,
      `   Evidence: ${issue.evidence}`,
      `   Cause: ${issue.cause}`
    ].join("\n"))
    .join("\n\n");

  return [
    "## Quality Score",
    `${clampScore(report.qualityScore)}`,
    "",
    "## Summary",
    report.summary.trim(),
    "",
    "## Issues",
    issues || "None"
  ].join("\n");
}

export function parseEvaluationReport(text: string): EvaluationReport {
  const qualitySection = extractSection(text, "Quality Score");
  const qualityInline = extractInlineField(text, "Quality Score") || qualitySection;
  const qualityMatch = qualityInline.match(/\d{1,3}(?:\.\d+)?/) ?? text.match(/quality\s*score[^\d]*(\d{1,3}(?:\.\d+)?)/i);
  const qualityScore = clampScore(Number(qualityMatch?.[1] ?? qualityMatch?.[0] ?? 0));

  const summarySection = extractSection(text, "Summary");
  const summaryInline = extractInlineField(text, "Summary");
  const summary = (summarySection || summaryInline || "No summary provided").trim();

  const issues = parseIssues(text);

  return {
    qualityScore,
    summary,
    issues
  };
}
