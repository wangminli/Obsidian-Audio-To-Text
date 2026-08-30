import esbuild from "esbuild";
import process from "process";

const production = process.argv.includes("--production");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching for changes...");
}
