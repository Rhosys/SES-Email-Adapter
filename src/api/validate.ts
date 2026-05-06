import { z } from "zod";
import { HTTPException } from "hono/http-exception";

export async function zParse<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { raw = null; }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HTTPException(400, {
      res: Response.json(
        { title: "Invalid request body", errorCode: "INVALID_REQUEST", details: result.error.flatten() },
        { status: 400 },
      ),
    });
  }
  return result.data;
}
