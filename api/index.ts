import type { Request, Response } from "express";
import app from "../server/index.js";

export default function handler(req: Request, res: Response) {
  const requestUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const apiPath = requestUrl.searchParams.get("__path");
  if (apiPath) {
    requestUrl.searchParams.delete("__path");
    req.url = `/api/${apiPath}${requestUrl.search}`;
  }
  return app(req, res);
}
