import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const destination = resolve(process.argv[2] ?? ".");
mkdirSync(destination, { recursive: true });
const [legacy] = JSON.parse(execFileSync(
  "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" },
));
const staging = mkdtempSync(join(tmpdir(), "koreaaitel-sdk-"));

try {
  for (const { path } of legacy.files) {
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }

  const manifestPath = join(staging, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = "@koreaaitel/sdk";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const readme = join(staging, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replaceAll(legacy.name, manifest.name));

  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", destination],
    { cwd: staging, stdio: "inherit" },
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
