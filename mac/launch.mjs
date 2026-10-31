import { spawn } from "node:child_process";
import { config } from "../dist/config.js";
import { buildApp } from "../dist/app.js";
import { assertPortFree } from "./server-port.mjs";
try {
  const c = { ...config(), HOST: "127.0.0.1" };
  await assertPortFree(c.PORT);
  const { app } = await buildApp(c);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close();
    });
  await app.listen({ host: c.HOST, port: c.PORT });
  const url = `http://127.0.0.1:${c.PORT}`;
  console.log(`Stemme er klar. Åbn ${url} i din browser.`);
  const opener = spawn("open", [url], { stdio: "ignore" });
  opener.on("error", () =>
    console.log(
      "Browseren kunne ikke åbnes automatisk. Brug adressen ovenfor.",
    ),
  );
} catch (error) {
  console.error(
    error?.code === "EADDRINUSE"
      ? "Der kører allerede en server på denne port. Find det GAMLE Stemme-Terminal-vindue, tryk Control+C dér, og åbn Start.command igen. Den gamle server bruger ikke automatisk den nye backend."
      : "Opstart mislykkedes. Kontrollér Node-version, .env-indstillinger og om Stemme allerede kører.",
  );
  process.exitCode = 1;
}
