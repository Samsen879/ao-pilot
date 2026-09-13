import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateConfigHash, getSessionsDir, generateTmuxName } from "../paths.js";
function fixture(run: (root: string) => void) {
 const root = mkdtempSync(join(tmpdir(), "ao-identity-regression-"));
 try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
describe("recovery namespace boundary (#107)", () => {
 it("separates same-name sessions and runtime names across config directories", () => fixture(root => {
  for (const dir of ["a", "b"]) { mkdirSync(join(root, dir)); writeFileSync(join(root, dir, "config.yaml"), "projects: {}"); }
  const a = join(root, "a/config.yaml"), b = join(root, "b/config.yaml");
  expect(getSessionsDir(a, "/fixture/project")).not.toBe(getSessionsDir(b, "/fixture/project"));
  expect(generateTmuxName(a, "same", 1)).not.toBe(generateTmuxName(b, "same", 1));
 }));
 it("characterizes same-directory collision rather than configuration fingerprinting", () => fixture(root => {
  const a = join(root, "a.yaml"), b = join(root, "b.yaml");
  writeFileSync(a, "projects: {}"); writeFileSync(b, "projects: {other: {}}");
  expect(generateConfigHash(a)).toBe(generateConfigHash(b));
  expect(getSessionsDir(a, "/fixture/project")).toBe(getSessionsDir(b, "/fixture/project"));
 }));
 it("characterizes in-place config edits as namespace-stable", () => fixture(root => {
  const a = join(root, "config.yaml"); writeFileSync(a, "projects: {}"); const before = generateConfigHash(a);
  writeFileSync(a, "projects: {changed: {}}"); expect(generateConfigHash(a)).toBe(before);
 }));
 it("characterizes basename aliasing across project paths and distinct-basename separation", () => fixture(root => {
  const a=join(root,"config.yaml");writeFileSync(a,"projects: {}");
  expect(getSessionsDir(a,"/one/project")).toBe(getSessionsDir(a,"/two/project"));
  expect(getSessionsDir(a,"/one/project")).not.toBe(getSessionsDir(a,"/one/other"));
 }));
 it("resolves config symlinks to original namespace", () => fixture(root => {
  const a = join(root, "config.yaml"), link = join(root, "alias.yaml");
  writeFileSync(a, "projects: {}"); symlinkSync(a, link); expect(generateConfigHash(link)).toBe(generateConfigHash(a));
 }));
});
