const t0 = performance.now();
const { TypeBoxCompiler } = await import("@earendil-works/pi-ai");
console.log("[timing] pi-ai import:", (performance.now() - t0).toFixed(0), "ms");
const t1 = performance.now();
const typebox = await import("typebox");
console.log("[timing] typebox import:", (performance.now() - t1).toFixed(0), "ms");
