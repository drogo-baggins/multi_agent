import type { EvaluationReport, IssueCategory } from "./evaluation-report.js";

export interface ImprovementRequest {
  issueCategory: IssueCategory;
  issueEvidence: string;
  workProductExcerpt: string;
  relatedConfigSection: string;
  improvementDirection: string;
  userFeedback: string;
}

function excerptAround(text: string, needle: string, radius = 140): string {
  const cleanText = text.trim();
  if (cleanText.length === 0) {
    return "N/A";
  }
  const target = needle.trim();
  if (target.length === 0) {
    return cleanText.slice(0, 280);
  }
  const sourceLower = cleanText.toLowerCase();
  const targetLower = target.toLowerCase();
  const index = sourceLower.indexOf(targetLower);
  if (index === -1) {
    return cleanText.slice(0, 280);
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(cleanText.length, index + target.length + radius);
  return cleanText.slice(start, end);
}

function configKeyword(category: IssueCategory): string {
  if (category === "coverage") {
    return "coverage";
  }
  if (category === "accuracy") {
    return "accuracy";
  }
  if (category === "structure") {
    return "structure";
  }
  if (category === "citations") {
    return "citation";
  }
  return "";
}

function inferImprovementDirection(category: IssueCategory, description: string, userFeedback: string): string {
  return `Prioritize ${category} improvements. Address issue: ${description}. Incorporate user feedback: ${userFeedback}`;
}

export function formatImprovementRequest(request: ImprovementRequest): string {
  return [
    "## Issue Category and Evidence",
    `Category: ${request.issueCategory}`,
    `Evidence: ${request.issueEvidence}`,
    "",
    "## Work Product Excerpt",
    request.workProductExcerpt,
    "",
    "## Related Config Section",
    request.relatedConfigSection,
    "",
    "## Improvement Direction",
    request.improvementDirection,
    "",
    "## User Feedback",
    request.userFeedback
  ].join("\n");
}

export function buildImprovementRequests(
  report: EvaluationReport,
  workProduct: string,
  currentConfig: string,
  userFeedback: string
): ImprovementRequest[] {
  return report.issues
    .filter((issue) => issue.cause === "config")
    .map((issue) => {
      const keyword = configKeyword(issue.category);
      const relatedConfigSection = excerptAround(currentConfig, keyword || issue.description);
      const workProductExcerpt = excerptAround(workProduct, issue.evidence);
      return {
        issueCategory: issue.category,
        issueEvidence: issue.evidence,
        workProductExcerpt,
        relatedConfigSection,
        improvementDirection: inferImprovementDirection(issue.category, issue.description, userFeedback),
        userFeedback
      };
    });
}
