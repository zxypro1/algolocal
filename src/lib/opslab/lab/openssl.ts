/**
 * openssl
 *
 * 只做和证书排查有关的那几条，但输出格式照抄真 openssl —— 学员对着
 * `Not After :` 和 `X509v3 Subject Alternative Name:` 这两行找问题，
 * 格式不一样就白搭。
 */
import type { CommandHandler, CommandResult } from '../machine';
import { parseChain, verifyChain, type Certificate } from '../crypto';

export function createOpensslCommand(): CommandHandler {
  return (context) => {
    const [subcommand, ...rest] = context.argv;
    switch (subcommand) {
      case 'x509': return x509(rest, context);
      case 'verify': return verifyCommand(rest, context);
      case 'version': return { stdout: 'OpenSSL 3.4.0 22 Oct 2024\n' };
      default:
        return {
          stderr: `openssl: 只实现了 x509 / verify / version（收到 ${subcommand ?? ''}）\n`,
          code: 1,
        };
    }
  };
}

function readPem(
  argv: string[],
  context: Parameters<CommandHandler>[0]
): { chain: Certificate[]; error?: string } {
  const index = argv.indexOf('-in');
  const stdin = context.stdin;
  const text = index >= 0
    ? (context.vfs.exists(resolve(context, argv[index + 1]))
      ? context.vfs.readFile(resolve(context, argv[index + 1]))
      : undefined)
    : stdin;
  if (text === undefined) {
    return { chain: [], error: `Could not open file or uri for loading certificate\n` };
  }
  try {
    const chain = parseChain(text);
    if (chain.length === 0) return { chain: [], error: 'unable to load certificate\n' };
    return { chain };
  } catch {
    return { chain: [], error: 'unable to load certificate\n' };
  }
}

function resolve(context: Parameters<CommandHandler>[0], path: string): string {
  return path.startsWith('/') ? path : `${context.cwd}/${path}`;
}

function x509(argv: string[], context: Parameters<CommandHandler>[0]): CommandResult {
  const { chain, error } = readPem(argv, context);
  if (error) return { stderr: error, code: 1 };
  const certificate = chain[0];

  const lines: string[] = [];
  const wants = (flag: string) => argv.includes(flag);
  const only = argv.some((arg) => ['-subject', '-issuer', '-dates', '-serial', '-ext'].includes(arg));

  if (wants('-subject')) lines.push(`subject=${nameOf(certificate.subject)}`);
  if (wants('-issuer')) lines.push(`issuer=${nameOf(certificate.issuer)}`);
  if (wants('-serial')) lines.push(`serial=${certificate.serial.toString(16).toUpperCase()}`);
  if (wants('-dates')) {
    lines.push(`notBefore=${opensslDate(certificate.notBefore)}`);
    lines.push(`notAfter=${opensslDate(certificate.notAfter)}`);
  }
  const extIndex = argv.indexOf('-ext');
  if (extIndex >= 0 && argv[extIndex + 1] === 'subjectAltName') {
    lines.push('X509v3 Subject Alternative Name:');
    lines.push(`    ${sanOf(certificate) || '<empty>'}`);
  }

  if (!only || wants('-text')) {
    lines.push(...textOf(certificate));
  }
  return { stdout: `${lines.join('\n')}\n` };
}

function textOf(certificate: Certificate): string[] {
  return [
    'Certificate:',
    '    Data:',
    '        Version: 3 (0x2)',
    `        Serial Number: ${certificate.serial.toString()} (0x${certificate.serial.toString(16)})`,
    '        Signature Algorithm: sha256WithRSAEncryption',
    `        Issuer: ${nameOf(certificate.issuer)}`,
    '        Validity',
    `            Not Before: ${opensslDate(certificate.notBefore)}`,
    `            Not After : ${opensslDate(certificate.notAfter)}`,
    `        Subject: ${nameOf(certificate.subject)}`,
    '        Subject Public Key Info:',
    '            Public Key Algorithm: rsaEncryption',
    '                Public-Key: (2048 bit)',
    '        X509v3 extensions:',
    `            X509v3 Basic Constraints: critical`,
    `                CA:${certificate.isCa ? 'TRUE' : 'FALSE'}`
      + (certificate.pathLength !== undefined ? `, pathlen:${certificate.pathLength}` : ''),
    ...(certificate.usages.length
      ? ['            X509v3 Extended Key Usage:', `                ${certificate.usages.map(usageName).join(', ')}`]
      : []),
    ...(sanOf(certificate)
      ? ['            X509v3 Subject Alternative Name:', `                ${sanOf(certificate)}`]
      : []),
  ];
}

function verifyCommand(argv: string[], context: Parameters<CommandHandler>[0]): CommandResult {
  const caIndex = argv.indexOf('-CAfile');
  const untrustedIndex = argv.indexOf('-untrusted');
  const target = argv.filter((arg) => !arg.startsWith('-')).filter(
    (arg) => arg !== argv[caIndex + 1] && arg !== argv[untrustedIndex + 1]
  )[0];
  if (!target) return { stderr: 'Usage: openssl verify [-CAfile file] cert.pem\n', code: 1 };

  const read = (path: string | undefined): Certificate[] => {
    if (!path) return [];
    const full = resolve(context, path);
    if (!context.vfs.exists(full)) return [];
    try { return parseChain(context.vfs.readFile(full)); } catch { return []; }
  };

  const chain = read(target);
  if (chain.length === 0) return { stderr: `unable to load certificate\n`, code: 1 };
  const roots = read(argv[caIndex + 1]);
  const untrusted = read(argv[untrustedIndex + 1]);

  const result = verifyChain({
    chain: [...chain, ...untrusted],
    roots,
    now: Date.now(),
  });
  if (result.ok) return { stdout: `${target}: OK\n` };
  return {
    stdout: `${target}: verification failed\n`,
    stderr: `error: ${result.error}\n`,
    code: 2,
  };
}

function nameOf(name: { commonName: string; organization?: string }): string {
  return [name.organization && `O = ${name.organization}`, `CN = ${name.commonName}`]
    .filter(Boolean).join(', ');
}

function sanOf(certificate: Certificate): string {
  return [
    ...certificate.dnsNames.map((name) => `DNS:${name}`),
    ...certificate.ipAddresses.map((ip) => `IP Address:${ip}`),
  ].join(', ');
}

function usageName(usage: string): string {
  return usage === 'serverAuth' ? 'TLS Web Server Authentication' : 'TLS Web Client Authentication';
}

/** `Mar  2 09:00:00 2026 GMT` —— 注意个位数日期前面是两个空格 */
function opensslDate(epochMs: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = new Date(epochMs);
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((value) => String(value).padStart(2, '0')).join(':');
  return `${months[date.getUTCMonth()]} ${day} ${time} ${date.getUTCFullYear()} GMT`;
}
