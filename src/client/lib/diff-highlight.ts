export type DiffToken = {
  content: string;
  lightColor?: string;
  darkColor?: string;
  fontStyle?: number;
};

type LanguageLoader = () => Promise<{ default: unknown }>;
type RawToken = {
  content: string;
  variants: { light?: { color?: string; fontStyle?: number }; dark?: { color?: string; fontStyle?: number } };
};
type SyntaxHighlighter = {
  loadLanguage: (language: unknown) => Promise<void>;
  codeToTokensWithThemes: (code: string, options: { lang: string; themes: { light: string; dark: string } }) => RawToken[][];
};

// 지원 문법을 실제 diff에서 처음 사용할 때만 별도 청크로 불러온다.
const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  bash: () => import("shiki/langs/shellscript.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".bash": "bash", ".zsh": "bash", ".sh": "bash",
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp",
  ".cs": "csharp", ".css": "css", ".go": "go",
  ".htm": "html", ".html": "html",
  ".java": "java", ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript",
  ".json": "json", ".jsonl": "json", ".jsonc": "jsonc", ".jsx": "jsx",
  ".kt": "kotlin", ".kts": "kotlin",
  ".md": "markdown", ".markdown": "markdown",
  ".php": "php", ".py": "python", ".rb": "ruby", ".rs": "rust",
  ".scss": "scss", ".sass": "scss", ".sql": "sql", ".svelte": "svelte", ".swift": "swift",
  ".toml": "toml", ".ts": "typescript", ".cts": "typescript", ".mts": "typescript", ".tsx": "tsx",
  ".vue": "vue", ".xml": "xml", ".svg": "xml", ".plist": "xml",
  ".yaml": "yaml", ".yml": "yaml",
};

let highlighterPromise: Promise<SyntaxHighlighter> | null = null;
const languageLoads = new Map<string, Promise<void>>();

// Shiki 코어와 밝은/어두운 GitHub 테마를 최초 diff에서 한 번만 초기화한다.
async function getHighlighter(): Promise<SyntaxHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]).then(([core, engine, light, dark]) => core.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    }) as Promise<SyntaxHighlighter>);
  }
  return highlighterPromise;
}

// 필요한 언어 문법만 동적으로 읽고 같은 언어의 중복 로드를 합친다.
async function loadLanguage(language: string): Promise<void> {
  if (!languageLoads.has(language)) {
    const loader = LANGUAGE_LOADERS[language];
    if (!loader) return;
    languageLoads.set(language, (async () => {
      const [highlighter, grammar] = await Promise.all([getHighlighter(), loader()]);
      await highlighter.loadLanguage(grammar.default);
    })());
  }
  await languageLoads.get(language);
}

// 파일명과 확장자를 Shiki 문법 ID로 변환하며 모르는 형식은 일반 텍스트로 남긴다.
export function diffLanguage(path?: string | null): string | null {
  if (!path) return null;
  const cleanPath = path.replace(/^['"]|['"]$/g, "");
  const name = cleanPath.split("/").pop()?.toLowerCase() || "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "make";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? EXTENSION_LANGUAGES[name.slice(dot)] || null : null;
}

// git 및 Codex 패치 헤더에서 변경 대상 파일 경로를 찾는다.
export function diffPath(diff: string): string | null {
  const patch = diff.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
  if (patch) return patch.trim();
  const added = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  if (added && added !== "/dev/null") return added.trim();
  const header = diff.match(/^diff --git a\/(.+?) b\/(.+)$/m)?.[2];
  return header?.trim() || null;
}

// 여러 코드 줄을 한 번에 토큰화해 줄 간 문법 상태와 원래 줄 정렬을 유지한다.
export async function highlightDiffLines(lines: string[], language: string): Promise<DiffToken[][]> {
  if (!LANGUAGE_LOADERS[language]) return [];
  await loadLanguage(language);
  const highlighter = await getHighlighter();
  const tokenLines = highlighter.codeToTokensWithThemes(lines.join("\n"), {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
  });
  return tokenLines.map((tokens) => tokens.map((token) => ({
    content: token.content,
    lightColor: token.variants.light?.color,
    darkColor: token.variants.dark?.color,
    fontStyle: token.variants.light?.fontStyle,
  })));
}
