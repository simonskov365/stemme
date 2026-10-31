import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Copy application code only; never reads or copies credentials or conversation data. */
export function copyUpdate(chosen) {
  const target = realpathSync(chosen);
  if (target === realpathSync(source))
    throw Error("Vælg din eksisterende installation, ikke den nye download.");
  if (
    !existsSync(join(target, ".env")) ||
    !existsSync(join(target, "Start.command"))
  )
    throw Error(
      "Mappen skal indeholde din eksisterende Start.command og .env.",
    );
  const manifest = JSON.parse(
    readFileSync(join(target, "package.json"), "utf8"),
  );
  if (manifest.name !== "stemme-backend")
    throw Error("Den valgte mappe er ikke en Stemme-installation.");
  const entries = [
    "src",
    "public",
    "migrations",
    "mac",
    "docs",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "Start.command",
    "Installer.command",
    "Opdater.command",
    "README.md",
  ];
  function copy(path) {
    const from = join(source, path),
      to = join(target, path);
    if (
      lstatSync(from).isSymbolicLink() ||
      (existsSync(to) && lstatSync(to).isSymbolicLink())
    )
      throw Error("Opdateringen kan ikke kopiere gennem symbolske links.");
    if (lstatSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) copy(join(path, name));
    } else cpSync(from, to, { force: true });
  }
  for (const path of entries) if (existsSync(join(source, path))) copy(path);
  return target;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const target = copyUpdate(process.argv[2]);
    console.log(
      "Programfiler er opdateret. Dine nøgler, samtaler og assistentinstruktioner er bevaret.",
    );
    for (const args of [
      ["ci", "--include=dev", "--no-audit", "--no-fund"],
      ["run", "build"],
    ]) {
      const r = spawnSync("npm", args, { cwd: target, stdio: "inherit" });
      if (r.error || r.status !== 0)
        throw Error(
          "Installation eller build mislykkedes. Prøv Opdater.command igen.",
        );
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Opdateringen mislykkedes.");
    process.exitCode = 1;
  }
}
