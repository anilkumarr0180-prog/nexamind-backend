import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export const validate = (schema: ZodType): RequestHandler => {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request data",
          details: result.error.issues,
        },
      });

      return;
    }

    next();
  };
};