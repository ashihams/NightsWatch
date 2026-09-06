/**
 * Vercel serverless entry — routes all traffic through the dashboard handler.
 * Static files + /api/* are served the same way as local `npm run dashboard`.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handle } from "../dashboard/server.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  process.env.VERCEL = process.env.VERCEL || "1";
  await handle(req as unknown as import("node:http").IncomingMessage, res);
}
