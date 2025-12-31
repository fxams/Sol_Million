import express from "express";
import cors from "cors";
import apiRouter from "./routes/api.js";
import { env } from "./utils/env.js";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: env.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type"]
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", apiRouter);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${env.port}`);
});

