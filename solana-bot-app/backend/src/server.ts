import express from "express";
import cors from "cors";
import apiRouter from "./routes/api.js";
import { env } from "./utils/env.js";
import { ensureTokenMonitoring } from "./services/pumpfunTokenMonitor.js";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: env.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type"]
  })
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    // These are safe to expose (not secrets). Useful for deployment debugging.
    frontendOrigin: env.frontendOrigin,
    pumpfunProgramId: env.pumpfunProgramId ?? null,
    pumpfunProgramIdSet: Boolean(env.pumpfunProgramId),
    jitoBlockEngineUrl: env.jitoBlockEngineUrl
  })
);
app.use("/api", apiRouter);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${env.port}`);
  // eslint-disable-next-line no-console
  console.log(`PUMPFUN_PROGRAM_ID set: ${Boolean(env.pumpfunProgramId)}${env.pumpfunProgramId ? ` (${env.pumpfunProgramId})` : ""}`);
  
  // Start token monitoring for mainnet (can be started on-demand via API too)
  if (env.pumpfunProgramId) {
    ensureTokenMonitoring("mainnet-beta").catch((e) => {
      // eslint-disable-next-line no-console
      console.error("Failed to start token monitoring:", e);
    });
  }
});

