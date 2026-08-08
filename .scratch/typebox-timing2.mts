const t0 = performance.now();
const { TypeBoxCompiler } = await import("@earendil-works/pi-ai");
console.log("[timing] pi-ai import (2nd run):", (performance.now() - t0).toFixed(0), "ms");
