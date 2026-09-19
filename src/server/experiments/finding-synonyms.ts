// 구체적 분류는 서로 동의어가 아니다. 상위 범주(security, correctness)만 그 가족 전체와 맞는다.

export type FindingFamily = "correctness" | "security" | "quality";

interface SynonymGroup {
  canonical: string;
  family: FindingFamily;
  parent?: boolean;
  aliases: string[];
}

const FINDING_GROUPS: SynonymGroup[] = [
  { canonical: "correctness", family: "correctness", parent: true, aliases: ["bug", "logic", "logic-error"] },
  { canonical: "off-by-one", family: "correctness", aliases: ["off-by-1", "obo", "경계값-오류", "경계-오류"] },
  { canonical: "null-deref", family: "correctness", aliases: ["npe", "null-pointer", "null-dereference", "null-dereference-exception"] },
  { canonical: "race", family: "correctness", aliases: ["race-condition", "concurrency"] },
  { canonical: "error-handling", family: "correctness", aliases: ["exception", "swallowed-error"] },
  { canonical: "api-misuse", family: "correctness", aliases: ["contract", "precondition"] },
  { canonical: "security", family: "security", parent: true, aliases: ["vulnerability", "vuln", "보안"] },
  { canonical: "sql-injection", family: "security", aliases: ["sqli", "cwe-89", "sql-인젝션"] },
  { canonical: "command-injection", family: "security", aliases: ["os-command", "cwe-78"] },
  { canonical: "xss", family: "security", aliases: ["cross-site-scripting", "cwe-79"] },
  { canonical: "path-traversal", family: "security", aliases: ["directory-traversal", "cwe-22"] },
  { canonical: "ssrf", family: "security", aliases: ["cwe-918"] },
  { canonical: "xxe", family: "security", aliases: ["cwe-611"] },
  { canonical: "csrf", family: "security", aliases: ["cwe-352"] },
  { canonical: "authn", family: "security", aliases: ["authentication", "broken-auth"] },
  { canonical: "authz", family: "security", aliases: ["authorization", "idor", "cwe-285", "cwe-639"] },
  { canonical: "secret", family: "security", aliases: ["hardcoded-secret", "credential"] },
  { canonical: "crypto", family: "security", aliases: ["weak-crypto", "cwe-327"] },
  { canonical: "open-redirect", family: "security", aliases: ["redirect"] },
  { canonical: "deserialization", family: "security", aliases: ["cwe-502"] },
  { canonical: "quality", family: "quality", parent: true, aliases: [] },
  { canonical: "resource-leak", family: "quality", aliases: ["leak", "handle-leak"] },
  { canonical: "performance", family: "quality", aliases: ["perf"] },
  { canonical: "maintainability", family: "quality", aliases: ["nit", "style", "readability"] },
];

export interface ResolvedFindingCategory {
  canonical: string;
  family: FindingFamily | null;
  isParent: boolean;
  inTable: boolean;
}

function normalizeCategoryToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function buildMap(groups: SynonymGroup[]): Map<string, ResolvedFindingCategory> {
  const map = new Map<string, ResolvedFindingCategory>();
  for (const group of groups) {
    const canonical = normalizeCategoryToken(group.canonical);
    const resolved: ResolvedFindingCategory = {
      canonical, family: group.family, isParent: group.parent === true, inTable: true,
    };
    map.set(canonical, resolved);
    for (const alias of group.aliases) map.set(normalizeCategoryToken(alias), resolved);
  }
  return map;
}

const CATEGORY_MAP = buildMap(FINDING_GROUPS);

// taxonomy는 프롬프트 식별자일 뿐 매칭 vocabulary를 줄이지 않는다.
export function resolveFindingCategory(value: string, _taxonomy?: string | null): ResolvedFindingCategory {
  const token = normalizeCategoryToken(value);
  return CATEGORY_MAP.get(token) ?? { canonical: token, family: null, isParent: false, inTable: false };
}

// 같은 말이거나, 한쪽이 상위 범주이고 가족이 같을 때만 자동 매칭한다. 형제 CWE는 맞지 않는다.
export function categoriesCompatible(report: ResolvedFindingCategory, truth: ResolvedFindingCategory): boolean {
  if (report.canonical === truth.canonical) return true;
  if (!report.inTable || !truth.inTable || report.family === null || report.family !== truth.family) return false;
  return report.isParent || truth.isParent;
}
