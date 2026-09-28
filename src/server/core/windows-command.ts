// Windows에서 npm으로 설치한 CLI(codex.cmd, claude.cmd 등)는 배치 스크립트라 Node가 셸 없이 실행하지 않는다
// (spawn/execFile이 EINVAL). 스크립트형 실행 파일만 cmd.exe로 감싸 실행하는 인자를 만든다(#143).
// 인자는 앱이 정한 고정 값만 들어오므로, 공백·따옴표만 cmd 규칙대로 감싼다.

export interface ResolvedCommand {
  command: string;
  args: string[];
  // true면 spawn/execFile에 windowsVerbatimArguments를 줘 Node가 인자를 다시 따옴표 처리하지 않게 한다.
  verbatim: boolean;
}

function quoteForCmd(value: string): string {
  if (/^[A-Za-z0-9_\-./:=@\\]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function isWindowsScript(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable);
}

// 실행 파일과 인자를 이 플랫폼에서 바로 실행할 수 있는 형태로 바꾼다.
export function resolveCommand(executable: string, args: string[], platform: NodeJS.Platform = process.platform, comspec = process.env.ComSpec || "cmd.exe"): ResolvedCommand {
  if (platform !== "win32" || !isWindowsScript(executable)) return { command: executable, args, verbatim: false };
  const commandLine = [`"${executable}"`, ...args.map(quoteForCmd)].join(" ");
  // /s와 바깥 따옴표로 cmd가 첫·마지막 따옴표만 벗기고 나머지는 그대로 실행한다.
  return { command: comspec, args: ["/d", "/s", "/c", `"${commandLine}"`], verbatim: true };
}

// node-pty는 Windows에서 명령줄 문자열을 그대로 받을 수 있다. 스크립트형이면 cmd.exe와 명령줄 문자열을 준다.
export function resolvePtyCommand(executable: string, args: string[], platform: NodeJS.Platform = process.platform, comspec = process.env.ComSpec || "cmd.exe"): { file: string; args: string[] | string } {
  const resolved = resolveCommand(executable, args, platform, comspec);
  return resolved.verbatim ? { file: resolved.command, args: resolved.args.join(" ") } : { file: resolved.command, args: resolved.args };
}
