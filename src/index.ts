import { createApp } from "./app.js";
import { createEntraVerifier } from "./auth.js";
import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  const app = createApp(config, createEntraVerifier(config));

  app.listen(config.port, config.host, () => {
    console.log(
      `MCP server listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`Expected issuer:   ${config.issuer}`);
    console.log(`Expected audience: ${config.audiences.join(", ")}`);
    console.log(`Required scope:    ${config.requiredScope}`);
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
