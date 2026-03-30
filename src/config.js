import path from "node:path";
import { mkdir } from "node:fs/promises";

const rootDir = process.cwd();

export const paths = {
  rootDir,
  authDir: path.join(rootDir, ".auth", "linkedin"),
  outputDir: path.join(rootDir, ".output"),
  sessionsDir: path.join(rootDir, ".output", "sessions"),
};

export async function ensureProjectDirs() {
  await mkdir(paths.authDir, { recursive: true });
  await mkdir(paths.outputDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
}
