const mod = await import("../index.js");

if (!mod?.default?.id) {
  throw new Error("Plugin default export is missing id");
}

console.log(`import ok: ${mod.default.id}`);

