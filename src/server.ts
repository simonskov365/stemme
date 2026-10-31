import { config } from "./config.js";
import { buildApp } from "./app.js";
try {
  const c = config();
  const { app } = await buildApp(c);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close();
    });
  await app.listen({ host: c.HOST, port: c.PORT });
} catch (e) {
  console.error(
    e instanceof Error && e.message.startsWith("Invalid configuration:")
      ? e.message
      : "Startup failed. Check configuration, instruction file, database permissions and port.",
  );
  process.exitCode = 1;
}
