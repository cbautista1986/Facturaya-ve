import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "./src/index";
import { crearBaseDatosD1 } from "./src/d1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3000;

const db = crearBaseDatosD1();
const servidor = new Hono();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// Montar las rutas de la API de Hono inyectando el binding DB compatible con D1
servidor.all("/api/*", (c) => app.fetch(c.req.raw, { DB: db }));

// Servir archivos estáticos de la carpeta public/
servidor.get("*", async (c) => {
  const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
  const seguro = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const archivo = path.join(PUBLIC_DIR, seguro);

  if (!archivo.startsWith(PUBLIC_DIR)) {
    return c.text("No encontrado", 404);
  }

  try {
    const stat = await fs.stat(archivo);
    const destino = stat.isDirectory() ? path.join(archivo, "index.html") : archivo;
    const contenido = await fs.readFile(destino);
    const ext = path.extname(destino).toLowerCase();
    return new Response(contenido, {
      status: 200,
      headers: {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
      },
    });
  } catch {
    return c.text("No encontrado", 404);
  }
});

serve(
  {
    fetch: servidor.fetch,
    port: PORT,
    hostname: "0.0.0.0",
  },
  (info) => {
    console.log(`Servidor corriendo en http://${info.address}:${info.port}`);
  }
);
