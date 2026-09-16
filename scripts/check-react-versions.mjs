import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// react and react-dom ship in lockstep and must declare the same version.
// Dependabot groups their minor/patch updates but only bundles the releases
// available at that moment, so grouping alone cannot guarantee they stay
// aligned — this check is the enforcement.
export function reactVersionMismatch(pkg) {
  const dependencies = pkg.dependencies ?? {};
  const react = dependencies.react;
  const reactDom = dependencies["react-dom"];

  if (!react || !reactDom) {
    return "package.json must declare both react and react-dom in dependencies.";
  }
  if (react !== reactDom) {
    return (
      `react and react-dom must declare the same version: ` +
      `react is "${react}", react-dom is "${reactDom}".`
    );
  }
  return null;
}

const invokedDirectly =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );

  const mismatch = reactVersionMismatch(pkg);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }
  console.log(`react and react-dom versions match (${pkg.dependencies.react}).`);
}
