import net from "node:net";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth";

export const DEFAULT_TRUSTED_NETWORKS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

// 쉼표로 구분한 CIDR 설정을 기본 목록 또는 빈 목록과 합의된 형태로 정규화한다.
export function parseCidrs(value: string | undefined, fallback: string[] = []): string[] {
  const entries = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return entries?.length ? entries : [...fallback];
}

// IPv4-mapped IPv6 주소를 IPv4로 바꿔 CIDR 검사 결과를 일관되게 만든다.
function normalizeAddress(address: string): string {
  const value = address.split("%", 1)[0];
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : value;
}

// CIDR 문자열을 Node BlockList에 추가하며 주소·prefix 범위를 검증한다.
function addCidr(blockList: net.BlockList, cidr: string): void {
  const [rawAddress, rawPrefix] = cidr.split("/", 2);
  const address = normalizeAddress(rawAddress);
  const version = net.isIP(address);
  if (!version) throw new Error(`유효하지 않은 네트워크 주소입니다: ${cidr}`);
  const maxPrefix = version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? maxPrefix : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) throw new Error(`유효하지 않은 CIDR prefix입니다: ${cidr}`);
  blockList.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
}

// 설정된 CIDR 목록을 한 번 컴파일해 반복 요청에서 재사용한다.
function createBlockList(cidrs: string[]): net.BlockList {
  const blockList = new net.BlockList();
  for (const cidr of cidrs) addCidr(blockList, cidr);
  return blockList;
}

// 정규화한 IP 주소를 이미 컴파일된 네트워크 목록에서 검사한다.
function checkBlockList(address: string | undefined, blockList: net.BlockList): boolean {
  if (!address) return false;
  const normalized = normalizeAddress(address);
  const version = net.isIP(normalized);
  return version ? blockList.check(normalized, version === 4 ? "ipv4" : "ipv6") : false;
}

// 요청 주소가 허용된 내부·VPN CIDR 중 하나에 포함되는지 판정한다.
export function isTrustedNetworkAddress(address: string | undefined, cidrs: string[]): boolean {
  return checkBlockList(address, createBlockList(cidrs));
}

// reverse proxy가 원 클라이언트를 알리려고 붙이는 헤더들. 하나라도 있으면 프록시를 거친 요청으로 본다.
const FORWARDED_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip"];

// 신뢰 프록시를 지정하지 않은 상태에서 프록시를 거쳐 들어왔는지 판정한다.
// 이때 request.ip는 방문자가 아니라 프록시 주소라 내부망 대역과 무조건 일치해버리므로,
// 실제 출처를 알 수 없다고 보고 내부망 판정을 포기해야 외부 접속이 내부망으로 새지 않는다.
function isUnverifiedProxyRequest(request: AuthenticatedRequest, trustProxyConfigured: boolean): boolean {
  if (trustProxyConfigured) return false;
  return FORWARDED_HEADERS.some((header) => Boolean(request.headers[header]));
}

// 되돌릴 수 없는 작업(삭제·강제 종료 등)을 내부망 요청으로만 제한한다.
// 파일 탭의 민감 경로 정책과 같은 기준을 쓰되, 여기서는 조회가 아니라 파괴적 동작 자체를 막는다.
export function requireTrustedNetwork(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (request.trustedNetwork !== true) {
    response.status(403).json({ error: "되돌릴 수 없는 작업은 내부망에서만 할 수 있습니다." });
    return;
  }
  next();
}

// 현재 요청 IP의 내부망 capability를 다음 인증·파일 라우터가 사용하도록 주입한다.
export function createNetworkCapability(trustedNetworks: string[], trustProxyConfigured = false) {
  const blockList = createBlockList(trustedNetworks);
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    request.networkOriginTrusted = !isUnverifiedProxyRequest(request, trustProxyConfigured)
      && checkBlockList(request.ip || request.socket.remoteAddress, blockList);
    request.trustedNetwork = request.networkOriginTrusted;
    next();
  };
}
