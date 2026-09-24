/**
 * The signing carve-out (AGENTS.md): signing, sending transactions and handling private keys are
 * allowed only in scripts/, on devnet, with in-memory throwaway keys, and never in core, cli or
 * web. This test fails if signing code appears anywhere else.
 *
 * - Every source file under packages/ and apps/ (tests included) is scanned for signing, sending
 *   and key-creation APIs.
 * - Shipped code (not tests) may not import @solana/web3.js, @sqds/multisig or @solana/signers at
 *   all, and no package may list them as a runtime dependency (tests may use them as
 *   devDependencies for cross-checks, per AGENTS.md).
 * - In scripts/, the raw APIs may appear only in scripts/lib/devnet.ts, which must keep its
 *   devnet genesis-hash guard and must not touch the file system.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Signing, sending and key-creation APIs of @solana/kit, @solana/web3.js and WebCrypto. */
const SIGNING = [
  /\bKeypair\b/,
  /\bgenerateKeyPair(Signer)?\b/,
  /\bcreateKeyPair(Signer)?From\w*\b/,
  /\bKeyPairSigner\b/,
  /\b(partially)?[sS]ignTransaction(MessageWithSigners)?\b/,
  /\bsignAndSendTransaction\w*\b/,
  /\bsendAndConfirm\w*\b/,
  /\bsendTransaction(WithoutConfirming\w*)?\s*\(/,
  /\bsendRawTransaction\b/,
  /\brequestAirdrop\b/,
  /\bairdropFactory\b/,
  /\bsignBytes\b/,
  /\bfromSecretKey\b/,
  /\bsecretKey\b/,
  /\bsubtle\.sign\b/,
  /\btweetnacl\b/,
  /from\s+["']@solana\/signers["']/,
];

const SIGNING_PACKAGES = /from\s+["'](@solana\/web3\.js|@sqds\/multisig|@solana\/signers)["']/;

/** This file lists the patterns it looks for, so it is the one file not scanned. No other exception. */
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith("dist") || name === "coverage") {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function productFiles(): string[] {
  return ["packages", "apps"].flatMap((top) =>
    readdirSync(path.join(ROOT, top)).flatMap((pkg) => {
      const dir = path.join(ROOT, top, pkg);
      return statSync(dir).isDirectory() ? walk(dir) : [];
    }),
  );
}

function hits(text: string): string[] {
  return SIGNING.filter((pattern) => pattern.test(text)).map(String);
}

describe("signing boundary", () => {
  it("no signing, sending or key-creation code in core, cli, web or the proxy", () => {
    const files = productFiles().filter((file) => file !== SELF);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((file) => ({ file: relative(file), found: hits(readFileSync(file, "utf8")) }))
      .filter(({ found }) => found.length > 0);
    expect(offenders).toEqual([]);
  });

  it("shipped code never imports @solana/web3.js, @sqds/multisig or @solana/signers", () => {
    const offenders = productFiles()
      .map(relative)
      .filter((file) => !/\.test\.tsx?$|\/test-support\//.test(file))
      .filter((file) => SIGNING_PACKAGES.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no package lists a signing library as a runtime dependency", () => {
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(path.join(ROOT, top))) {
        const manifest = path.join(ROOT, top, pkg, "package.json");
        const json = JSON.parse(readFileSync(manifest, "utf8")) as {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        const runtime = Object.keys({ ...json.dependencies, ...json.peerDependencies });
        expect(
          runtime.filter((name) =>
            /^(@solana\/web3\.js|@sqds\/multisig|@solana\/signers)$/.test(name),
          ),
        ).toEqual([]);
      }
    }
  });

  it("in scripts/, raw signing APIs live only in lib/devnet.ts, which keeps its cluster guard and no file access", () => {
    const scripts = walk(path.join(ROOT, "scripts")).map(relative);
    const signing = scripts.filter(
      (file) => hits(readFileSync(path.join(ROOT, file), "utf8")).length > 0,
    );
    expect(signing).toEqual(["scripts/lib/devnet.ts"]);
    const devnet = readFileSync(path.join(ROOT, "scripts/lib/devnet.ts"), "utf8");
    expect(devnet).toContain(
      'DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"',
    );
    // Mainnet and testnet are refused by genesis hash; anything else must be devnet or loopback.
    expect(devnet).toContain('"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet"');
    expect(devnet).toContain('"4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet"');
    expect(devnet).toMatch(/if \(forbidden !== undefined\) \{\s*throw new NotASigningClusterError/);
    expect(devnet).toMatch(
      /if \(!LOOPBACK_HOSTS\.has\(new URL\(url\)\.hostname\)\) \{\s*throw new NotASigningClusterError/,
    );
    expect(devnet).not.toMatch(
      /from\s+["']node:fs|from\s+["']fs|writeFile|\.secretKey|console\.\w+\([^)]*secret/,
    );
  });

  it("the detector itself catches signing code (mutation check)", () => {
    for (const sample of [
      "const k = Keypair.generate();",
      "await generateKeyPairSigner();",
      "await signTransactionMessageWithSigners(m);",
      "connection.sendTransaction(tx)",
      "await connection.requestAirdrop(k, 1)",
      'import { x } from "@solana/signers";',
      "crypto.subtle.sign('Ed25519', key, data)",
    ]) {
      expect(hits(sample)).not.toEqual([]);
    }
    expect(hits("simulateTransaction(tx, { sigVerify: false })")).toEqual([]);
  });
});
