import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export function configuredPort(target) {
  const line = readFileSync(join(target, ".env"), "utf8").match(
    /^\s*PORT\s*=\s*["']?(\d+)/m,
  );
  const port = Number(process.env.PORT ?? line?.[1] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Ugyldig serverport i konfigurationen.");
  return port;
}
export function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      reject(
        Object.assign(
          new Error(
            `Der kører stadig et program på port ${port}. Stop den gamle Stemme med Control+C i dens Terminal-vindue, og prøv igen. Ingen programfiler er opdateret endnu.`,
          ),
          { code: "EADDRINUSE" },
        ),
      );
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else
        reject(
          new Error("Kunne ikke kontrollere, om den gamle server er stoppet."),
        );
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(
        new Error(
          "Kontrollen af den gamle server tog for lang tid. Prøv igen.",
        ),
      );
    });
  });
}
